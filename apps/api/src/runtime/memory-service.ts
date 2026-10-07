/**
 * The memory service layer: the semantics the CLI and REST API share.
 *
 * Both `createLocalBackend` (in-process) and the Hono routes call these functions, so `onemem
 * remember` and `POST /v1/memories` can never drift apart. The rules encoded here:
 *
 * - **redaction before persist** (ADR-0007): the content is redacted first; the redacted text is
 *   what is hashed, stored, excerpted into evidence, and summarised. Redaction records carry
 *   kind + location + length — never a value;
 * - **provenance is mandatory** (ADR-0003 rule 4): every durable write mints a `sources` row and at
 *   least one evidence span;
 * - **forget ≠ delete** (memory-model.md §4, ADR-0010 §5): `forget` is an audited status transition
 *   to `archived` (the one status the transition machine lets you restore), never a row deletion;
 * - **cache invalidation after writes** (retrieval.md §5): every durable write path calls
 *   `engine.invalidateCache(projectId)`.
 */

import {
  MEMORY_STATUSES,
  DURABLE_MEMORY_TYPES,
  eventContentHash,
  memoryContentHash,
  normalizeEntityName,
  uuidv7,
  validateOnememoryEvent,
  type MemoryRecord,
  type MemorySearchRequest,
  type MemorySearchResponse,
  type MemoryStatus,
  type OnememoryEvent,
  type ProjectRecord,
  type Redaction,
  type UserRecord,
} from '@onememory-ai/core';
import {
  buildSessionContext,
  deriveLabel,
  deriveSummary,
  estimateTokens,
  type SessionContext,
} from '@onememory-ai/retrieval';
import { RedactEventError, isEventPathExcluded, redactEvent } from '@onememory-ai/security';
import { searchRepo, sourcesRepo } from '@onememory-ai/storage';

import type { OnememoryRuntime } from './composition';
import {
  runSessionEndLifecycle,
  type SessionEndObservation,
} from './session-lifecycle';
import {
  BackendError,
  type ForgetInput,
  type ForgetOutcome,
  type IngestOutcome,
  type IngestResult,
  type InspectResult,
  type ListOptions,
  type MemoryPageOptions,
  type MemoryPageResult,
  DEFAULT_MEMORY_PAGE_SIZE,
  MAX_MEMORY_PAGE_SIZE,
  type PurgeInput,
  type PurgeOutcome,
  type RememberInput,
  type RememberOutcome,
} from './types';

/** Explicit writes run no model; the label says so instead of pretending extraction happened. */
const EXPLICIT_PROMPT_VERSION = 'explicit-v1';

/** Cap for the stats/diagnostic read (`queryCurrent` caps at 1000 rows anyway). */
const PROJECT_MEMORY_READ_LIMIT = 1000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Resolve a project row or fail with an actionable message. */
export async function requireProject(
  runtime: OnememoryRuntime,
  projectId: string,
): Promise<ProjectRecord> {
  const project = await runtime.storage.store.getProject(projectId);
  if (project === null) {
    throw new BackendError(
      `project ${projectId} is not registered in this database — run 'onemem init' or create it with POST /v1/projects`,
      'not_found',
    );
  }
  return project;
}

/** The implicit local user (embedded/local mode has exactly one — storage owns that rule). */
export async function localUser(runtime: OnememoryRuntime): Promise<UserRecord> {
  return sourcesRepo.ensureLocalUser(runtime.storage.client);
}

// ---------------------------------------------------------------------------
// search / context / typed lists
// ---------------------------------------------------------------------------

export async function searchMemories(
  runtime: OnememoryRuntime,
  request: MemorySearchRequest,
): Promise<MemorySearchResponse> {
  if (request.project_id === undefined) {
    throw new BackendError('project_id is required for a search', 'invalid_request');
  }
  await requireProject(runtime, request.project_id);
  try {
    return await runtime.engine.search(request);
  } catch (error) {
    throw new BackendError(`invalid search request: ${errorMessage(error)}`, 'invalid_request');
  }
}

export async function sessionContext(
  runtime: OnememoryRuntime,
  projectId: string,
  options: { budget?: number } = {},
): Promise<SessionContext> {
  await requireProject(runtime, projectId);
  return buildSessionContext(
    { store: runtime.storage.store, client: runtime.storage.client },
    projectId,
    options.budget === undefined ? {} : { budget: options.budget },
  );
}

/**
 * The typed decision/failure lists (ADR-0010 §2: first-class REST endpoints).
 *
 * Implemented through the retrieval engine with a synthesized query so intent routing engages the
 * typed shortcuts (`latestAcceptedDecisions` / `recentFailures`) and every result carries
 * provenance, explain and a real token budget — no second packing implementation to keep in sync.
 */
export async function typedMemoryList(
  runtime: OnememoryRuntime,
  projectId: string,
  kind: 'decision' | 'failure',
  options: ListOptions = {},
): Promise<MemorySearchResponse> {
  return searchMemories(runtime, {
    query: options.query ?? kind,
    project_id: projectId,
    types: [kind],
    explain: false,
    ...(options.max_tokens === undefined ? {} : { max_tokens: options.max_tokens }),
    ...(options.max_memories === undefined ? {} : { max_memories: options.max_memories }),
  });
}

// ---------------------------------------------------------------------------
// explicit remember
// ---------------------------------------------------------------------------

export interface RememberOptions {
  /** Recorded in `extraction.adapter` and the source metadata (`cli` | `api` | `test`). */
  adapter: string;
  /** Audited actor; defaults to the local user. */
  actor?: string;
}

export async function rememberMemory(
  runtime: OnememoryRuntime,
  input: RememberInput,
  options: RememberOptions,
): Promise<RememberOutcome> {
  const project = await requireProject(runtime, input.project_id);
  const raw = input.content.trim();
  if (raw === '') throw new BackendError('content must not be empty', 'invalid_request');

  // 1. Redact BEFORE anything is hashed, stored, summarised, or excerpted (ADR-0007).
  const redacted = runtime.redactor.redactSync(raw);
  const content = typeof redacted.value === 'string' ? redacted.value : raw;
  const redactions = redacted.redactions;

  const user = await localUser(runtime);
  const actor = options.actor ?? `user:${user.id}`;
  const now = new Date().toISOString();
  const type = input.type ?? 'semantic';

  // 2. Provenance: a source row + at least one evidence span, always.
  const source = await runtime.storage.store.createSource({
    kind: 'explicit',
    uri: 'explicit/remember',
    title: 'explicit remember',
    content_hash: memoryContentHash(content),
    metadata: { adapter: options.adapter },
    project_id: project.id,
  });

  // 3. Store (the repository writes the audited `created` row in the same transaction).
  const write = await runtime.storage.store.insertMemory({
    type,
    ...(input.subtype === undefined ? {} : { subtype: input.subtype }),
    title: input.title ?? deriveLabel(undefined, content, 79),
    content,
    content_summary: deriveSummary(content, 160),
    importance: input.importance ?? 0.7,
    confidence: input.confidence ?? 0.9,
    observed_at: now,
    valid_from: now,
    project_id: project.id,
    user_id: user.id,
    source_id: source.id,
    evidence: [
      {
        source_id: source.id,
        kind: 'message',
        locator: 'explicit remember',
        excerpt: content.slice(0, 200),
      },
    ],
    extraction: {
      method: 'heuristic',
      prompt_version: EXPLICIT_PROMPT_VERSION,
      adapter: options.adapter,
    },
    tags: [...new Set([...(input.tags ?? []), 'explicit'])],
    token_estimate: estimateTokens(content),
  });

  const memoryId = write.memory.id;

  if (write.outcome === 'inserted') {
    if (input.entities !== undefined && input.entities.length > 0) {
      const bindings: Array<{ entity_id: string }> = [];
      for (const name of input.entities) {
        const normalized = normalizeEntityName(name);
        const existing = await runtime.storage.store.findEntity(
          { project_id: project.id },
          normalized,
        );
        const entity =
          existing ??
          (await runtime.storage.store.createEntity({
            project_id: project.id,
            kind: 'concept',
            name,
            normalized_name: normalized,
          }));
        bindings.push({ entity_id: entity.id });
      }
      await runtime.storage.store.bindMemoryEntities(
        memoryId,
        bindings.map((binding) => ({
          entity_id: binding.entity_id,
          role: 'subject' as const,
          weight: 1,
        })),
      );
      runtime.engine.invalidateEntityIndex();
    }

    if (redactions.length > 0) {
      // The audit trail is where redaction summaries belong (kind + location + length only).
      await runtime.storage.store.appendMemoryEvent({
        memory_id: memoryId,
        action: 'redacted',
        actor,
        details: {
          count: redactions.length,
          locations: redactions.map((record) => ({
            kind: record.kind,
            location: record.location,
            length: record.length,
          })),
        },
      });
    }
  }

  // 4. retrieval.md §5: a durable write invalidates the result cache.
  runtime.engine.invalidateCache(project.id);

  return {
    outcome: write.outcome,
    memory_id: memoryId,
    redactions,
    ...(write.existing === undefined ? {} : { duplicate_of: write.existing.id }),
    warnings: [],
  };
}

// ---------------------------------------------------------------------------
// forget / restore (never delete)
// ---------------------------------------------------------------------------

export interface ForgetOptions {
  adapter: string;
  actor?: string;
}

export async function forgetMemory(
  runtime: OnememoryRuntime,
  input: ForgetInput,
  options: ForgetOptions = { adapter: 'cli' },
): Promise<ForgetOutcome> {
  const project = await requireProject(runtime, input.project_id);
  const memory = await requireMemoryOfProject(runtime, input.memory_id, project.id);
  const user = await localUser(runtime);
  const actor = input.actor ?? `user:${user.id}`;

  if (memory.status === 'archived') {
    const audit = await runtime.storage.store.listMemoryEvents(memory.id);
    const lastArchived = [...audit].reverse().find((row) => row.to_status === 'archived');
    return {
      memory_id: memory.id,
      from_status: memory.status,
      to_status: memory.status,
      audit_event_id: lastArchived?.id ?? '',
      restore_hint: restoreHint(memory.id),
      purge_hint: purgeHint(),
      note: 'already forgotten (status archived) — nothing changed',
    };
  }

  const now = new Date().toISOString();
  const updated = await runtime.storage.store.updateMemoryStatus(memory.id, 'archived', {
    actor,
    reason: input.reason ?? 'forget',
    // Close the validity window so point-in-time queries stop reporting it as current.
    ...(memory.valid_until === undefined ? { valid_until: now } : {}),
    details: { forget: true, adapter: options.adapter },
  });
  const audit = await runtime.storage.store.listMemoryEvents(updated.id);
  const last = audit[audit.length - 1];

  runtime.engine.invalidateCache(project.id);

  return {
    memory_id: updated.id,
    from_status: memory.status,
    to_status: updated.status,
    audit_event_id: last?.id ?? '',
    restore_hint: restoreHint(updated.id),
    purge_hint: purgeHint(),
    note: 'soft forget: the row and its history are retained; only the status changed (never a delete)',
  };
}

/**
 * Undo a soft forget. `archived → active` is the transition machine's restore edge; without a way
 * to run it the "recoverable tombstone" claim would be unverifiable.
 */
export async function restoreMemory(
  runtime: OnememoryRuntime,
  input: ForgetInput,
  options: ForgetOptions = { adapter: 'cli' },
): Promise<ForgetOutcome> {
  const project = await requireProject(runtime, input.project_id);
  const memory = await requireMemoryOfProject(runtime, input.memory_id, project.id);
  const user = await localUser(runtime);
  const actor = input.actor ?? `user:${user.id}`;

  if (memory.status === 'active') {
    return {
      memory_id: memory.id,
      from_status: memory.status,
      to_status: memory.status,
      audit_event_id: '',
      restore_hint: '',
      purge_hint: purgeHint(),
      note: 'already active — nothing changed',
    };
  }

  const updated = await runtime.storage.store.updateMemoryStatus(memory.id, 'active', {
    actor,
    reason: input.reason ?? 'restore',
    details: { restore: true, adapter: options.adapter },
  });
  const audit = await runtime.storage.store.listMemoryEvents(updated.id);
  const last = audit[audit.length - 1];
  runtime.engine.invalidateCache(project.id);

  return {
    memory_id: updated.id,
    from_status: memory.status,
    to_status: updated.status,
    audit_event_id: last?.id ?? '',
    restore_hint: '',
    purge_hint: purgeHint(),
    note: 'restored: the status transition is recorded in memory_events',
  };
}

/**
 * Hard purge — the destructive counterpart of forget (forget ≠ delete, ADR-0010 §5). The storage
 * primitive deletes the row and its cascaded vectors/bindings/edges in ONE transaction; one
 * 'purged' audit row survives (`memory_events` is FK-less by design). The revision token makes a
 * purge never accidental; a stale revision is a conflict, never a guess.
 */
export async function purgeMemory(
  runtime: OnememoryRuntime,
  input: PurgeInput,
  options: ForgetOptions = { adapter: 'cli' },
): Promise<PurgeOutcome> {
  const project = await requireProject(runtime, input.project_id);
  const memory = await requireMemoryOfProject(runtime, input.memory_id, project.id);
  const user = await localUser(runtime);
  const actor = input.actor ?? `user:${user.id}`;

  if (memory.updated_at !== input.expected_revision) {
    throw new BackendError(
      `revision conflict: memory ${memory.id} is at revision ${memory.updated_at}, expected ${input.expected_revision} — re-read the memory and retry with the current revision`,
      'conflict',
    );
  }

  const result = await runtime.storage.store.deleteMemory(memory.id, {
    actor,
    reason: input.reason ?? 'purge',
    details: { purge: true, adapter: options.adapter },
  });
  if (result === null) {
    // Raced between the read and the purge — the row is already gone.
    throw new BackendError(`memory ${memory.id} was not found`, 'not_found');
  }

  runtime.engine.invalidateCache(project.id);

  return {
    memory_id: memory.id,
    purged: true,
    from_status: result.audit.from_status ?? memory.status,
    audit_event_id: result.audit.id,
    note: 'hard purge: the row and its vectors/bindings/edges are deleted; one purged audit row survives. This is NOT recoverable — forget is the reversible path',
  };
}

async function requireMemoryOfProject(
  runtime: OnememoryRuntime,
  memoryId: string,
  projectId: string,
): Promise<MemoryRecord> {
  const memory = await runtime.storage.store.getMemory(memoryId);
  if (memory === null) throw new BackendError(`memory ${memoryId} was not found`, 'not_found');
  if (memory.project_id !== projectId) {
    throw new BackendError(
      `memory ${memoryId} belongs to project ${memory.project_id ?? '(global scope)'}, not ${projectId}`,
      'conflict',
    );
  }
  return memory;
}

function restoreHint(memoryId: string): string {
  return `recoverable: 'onemem restore ${memoryId}' transitions archived → active and appends an audit row`;
}

function purgeHint(): string {
  return `destructive purge: 'onemem forget <id> --purge --revision <rev>' (or POST …/memories/<id>/purge) deletes the row for real — one 'purged' audit row survives`;
}

// ---------------------------------------------------------------------------
// inspect
// ---------------------------------------------------------------------------

export async function inspectMemory(
  runtime: OnememoryRuntime,
  projectId: string,
  memoryId: string,
): Promise<InspectResult> {
  await requireProject(runtime, projectId);
  const memory = await runtime.storage.store.getMemory(memoryId);
  if (memory === null) throw new BackendError(`memory ${memoryId} was not found`, 'not_found');
  if (memory.project_id !== undefined && memory.project_id !== projectId) {
    throw new BackendError(
      `memory ${memoryId} belongs to project ${memory.project_id}, not ${projectId}`,
      'conflict',
    );
  }

  const [history, audit, entities, edges] = await Promise.all([
    runtime.storage.store.historyOf(memoryId),
    runtime.storage.store.listMemoryEvents(memoryId),
    runtime.storage.store.listMemoryEntities(memoryId),
    runtime.storage.store.listEdges(memoryId),
  ]);

  // Redaction summaries live in the write-path audit rows; only kind/location/length were stored.
  const redactions: Redaction[] = [];
  for (const row of audit) {
    if (row.action !== 'redacted') continue;
    const locations = (row.details as { locations?: unknown }).locations;
    if (!Array.isArray(locations)) continue;
    for (const entry of locations) {
      const record = entry as { kind?: unknown; location?: unknown; length?: unknown };
      if (typeof record.kind !== 'string' || typeof record.location !== 'string') continue;
      redactions.push({
        kind: record.kind as Redaction['kind'],
        location: record.location,
        length: typeof record.length === 'number' ? record.length : 1,
      });
    }
  }

  return { memory, history, audit, entities, edges, redactions, warnings: [] };
}

// ---------------------------------------------------------------------------
// ingest (events → redaction → storage → normalize job)
// ---------------------------------------------------------------------------

/**
 * Ingest a batch of raw event envelopes (adapters and tests feed this).
 *
 * Drafts may omit id, ingested_at, content_hash, and redactions; those fields are completed here.
 * Per event: complete draft → validate the envelope → path exclusion (ADR-0007's first gate) →
 * redact → persist. A malformed event is dead-lettered with path+message issues only, an excluded
 * path is dropped whole, and duplicates are reported rather than silently ignored.
 */
function completeDraftEvent(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;

  const draft = raw as Record<string, unknown>;
  return {
    ...draft,
    ...(draft.id === undefined ? { id: uuidv7() } : {}),
    ...(draft.ingested_at === undefined ? { ingested_at: new Date().toISOString() } : {}),
    ...(draft.payload !== undefined && draft.content_hash === undefined
      ? { content_hash: eventContentHash(draft.payload) }
      : {}),
    ...(draft.redactions === undefined ? { redactions: [] } : {}),
  };
}

export async function ingestEvents(
  runtime: OnememoryRuntime,
  projectId: string,
  rawEvents: unknown[],
): Promise<IngestResult> {
  const project = await requireProject(runtime, projectId);
  const outcomes: IngestOutcome[] = [];
  const warnings: string[] = [];
  /** Distinct observed session ends (by session id) - one lifecycle pass each, after the loop. */
  const sessionEnds = new Map<string, SessionEndObservation>();
  let stored = 0;
  let duplicates = 0;
  let excluded = 0;
  let deadLettered = 0;
  let firstStoredId: string | null = null;

  for (const [index, raw] of rawEvents.entries()) {
    const validated = validateOnememoryEvent(completeDraftEvent(raw));
    if (!validated.ok) {
      deadLettered += 1;
      outcomes.push({
        index,
        status: 'dead-letter',
        reason: validated.dead_letter.issues
          .map((issue) => `${issue.path}: ${issue.message}`)
          .join('; ')
          .slice(0, 400),
      });
      continue;
    }

    const envelope: OnememoryEvent = validated.value;
    if (isEventPathExcluded(envelope, runtime.exclusionPolicy)) {
      excluded += 1;
      outcomes.push({ index, status: 'excluded', reason: 'path excluded by policy (ADR-0007)' });
      continue;
    }

    let redacted: { event: OnememoryEvent; redactions: Redaction[] };
    try {
      redacted = redactEvent(envelope, runtime.redaction);
    } catch (error) {
      deadLettered += 1;
      const issues =
        error instanceof RedactEventError
          ? error.issues.map((issue) => `${issue.path}: ${issue.message}`)
          : [];
      outcomes.push({
        index,
        status: 'dead-letter',
        reason: [errorMessage(error), ...issues].join('; ').slice(0, 400),
      });
      continue;
    }

    // The endpoint's project is authoritative: an event may not smuggle itself into another project.
    if (
      redacted.event.scope.project_id !== undefined &&
      redacted.event.scope.project_id !== project.id
    ) {
      deadLettered += 1;
      outcomes.push({
        index,
        status: 'dead-letter',
        reason: `event scope.project_id ${redacted.event.scope.project_id} does not match the endpoint project ${project.id}`,
      });
      continue;
    }
    const event: OnememoryEvent = {
      ...redacted.event,
      scope: { ...redacted.event.scope, project_id: project.id },
    };

    const result = await runtime.storage.store.ingestEvent(event);
    if (result.status === 'stored') {
      stored += 1;
      firstStoredId ??= result.event_id;
      outcomes.push({
        index,
        status: 'stored',
        event_id: result.event_id,
        redactions: redacted.redactions,
      });
    } else {
      duplicates += 1;
      outcomes.push({
        index,
        status: 'duplicate',
        event_id: result.event_id,
        ...(result.duplicate_of === undefined ? {} : { duplicate_of: result.duplicate_of }),
        redactions: redacted.redactions,
      });
    }

    // A stored OR duplicate session end observes the session's end. Duplicates deliberately
    // re-run the pass: it is idempotent (session-lifecycle.ts), and re-running heals a crash
    // between storing the event and running the pass - or picks up working rows the async
    // extraction pipeline inserted after an earlier end was observed.
    if (event.payload.kind === 'session.end') {
      const sessionId = event.scope.session_id;
      if (sessionId === undefined) {
        warnings.push(
          `session.end at index ${index} carries no scope.session_id - no session-end lifecycle pass can run`,
        );
      } else {
        sessionEnds.set(sessionId, {
          session_id: sessionId,
          runtime: event.source.runtime,
          ended_at: event.payload.ended_at ?? event.occurred_at,
          ...(event.payload.started_at === undefined
            ? {}
            : { started_at: event.payload.started_at }),
          ...(event.payload.summary === undefined ? {} : { summary: event.payload.summary }),
        });
      }
    }
  }

  let normalizeJobId: string | null = null;
  if (stored > 0 && firstStoredId !== null) {
    // One normalize job per ingest batch, uniquely keyed so concurrent batches cannot be coalesced
    // into a job that already read its pending list. The handler sweeps every pending event, so a
    // dead-lettered job is also self-healing on the next ingest.
    const enqueued = await runtime.storage.jobs.enqueue({
      kind: 'normalize',
      key: `normalize:${firstStoredId}`,
      payload: { project_id: project.id },
    });
    normalizeJobId = enqueued.job.id;
  }

  // Session-end lifecycle passes (memory-model.md §10): promote + sweep per observed end. The
  // pass summary rides the warnings channel - the only IngestResult field that can carry it
  // without a type change (types.ts is coordinator-owned).
  for (const observation of sessionEnds.values()) {
    const lifecycle = await runSessionEndLifecycle(runtime, project.id, observation);
    warnings.push(
      `session-end lifecycle for session ${observation.session_id}: ` +
        `promoted ${lifecycle.promoted} (inserted ${lifecycle.inserted}, ` +
        `linked_existing ${lifecycle.linked_existing}), ` +
        `skipped ${lifecycle.skipped_total} (promotion filter), failed ${lifecycle.failed}, ` +
        `expired_purged ${lifecycle.expired_purged} (global TTL sweep)` +
        (lifecycle.failures.length > 0 ? `; first failure: ${lifecycle.failures[0]}` : ''),
    );
  }

  if (stored === 0 && duplicates > 0) {
    warnings.push('every event in this batch was a duplicate — nothing new was queued');
  }

  return {
    outcomes,
    stored,
    duplicates,
    excluded,
    dead_lettered: deadLettered,
    normalize_job_id: normalizeJobId,
    warnings,
  };
}

/** Current memories of a project, read through the storage repository (stats + diagnostics). */
export async function listProjectMemories(
  runtime: OnememoryRuntime,
  projectId: string,
  options: { statuses?: readonly MemoryStatus[]; limit?: number } = {},
): Promise<MemoryRecord[]> {
  return searchRepo.listCurrentMemories(
    runtime.storage.client,
    {
      types: ['episodic', 'semantic', 'procedural', 'decision', 'failure', 'preference'],
      limit: options.limit ?? PROJECT_MEMORY_READ_LIMIT,
    },
    {
      statuses: options.statuses ?? MEMORY_STATUSES,
      // Open window: every validity window intersects the open range.
      window: { kind: 'overlap', from: null, until: null },
      projectId,
    },
  );
}

// ---------------------------------------------------------------------------
// keyset-paginated listing
// ---------------------------------------------------------------------------

/** The cursor is opaque to clients; its shape is a storage keyset position, base64url-encoded. */
function encodeMemoryCursor(cursor: searchRepo.MemoryPageCursor): string {
  return Buffer.from(JSON.stringify([cursor.observed_at_us, cursor.id]), 'utf-8').toString('base64url');
}

function decodeMemoryCursor(raw: string): searchRepo.MemoryPageCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf-8'));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      /^-?\d{1,19}$/.test(parsed[0]) &&
      typeof parsed[1] === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parsed[1])
    ) {
      return { observed_at_us: parsed[0], id: parsed[1] };
    }
  } catch {
    // fall through to the typed refusal
  }
  throw new BackendError(
    'invalid cursor — pass back the next_cursor of a previous page unchanged, or omit it for the first page',
    'invalid_request',
  );
}

export async function listMemoryPage(
  runtime: OnememoryRuntime,
  projectId: string,
  options: MemoryPageOptions = {},
): Promise<MemoryPageResult> {
  await requireProject(runtime, projectId);
  const pageSize = options.page_size ?? DEFAULT_MEMORY_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_MEMORY_PAGE_SIZE) {
    throw new BackendError(`page_size must be an integer in 1..${MAX_MEMORY_PAGE_SIZE}`, 'invalid_request');
  }
  const after = options.cursor === undefined ? undefined : decodeMemoryCursor(options.cursor);
  const page = await searchRepo.listMemoryPage(
    runtime.storage.client,
    {
      types: options.types === undefined || options.types.length === 0 ? DURABLE_MEMORY_TYPES : options.types,
      pageSize,
      ...(after === undefined ? {} : { after }),
    },
    {
      statuses: ['active', ...(options.include ?? [])],
      window: { kind: 'overlap', from: null, until: null },
      projectId,
    },
  );
  return {
    project_id: projectId,
    page_size: pageSize,
    memories: page.memories,
    next_cursor: page.next === null ? null : encodeMemoryCursor(page.next),
  };
}

/** Exported for the stats module and tests (one read cap, one definition). */
export { PROJECT_MEMORY_READ_LIMIT };
