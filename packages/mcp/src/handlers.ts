/**
 * The tool handlers — every tool's behavior as a pure `(ctx, args) → payload` function.
 *
 * Contract (ADR-0010):
 * - reads ride the retrieval engine (`memory_search`, `memory_project_context`) or the Store
 *   port (`memory_get`, `memory_related`, curated lists) — retrieval is NEVER reimplemented here;
 * - writes redact BEFORE persisting (ADR-0007 via @onememory/security) and enforce the
 *   provenance gate (memory-model.md §6: no source + evidence → not durable);
 * - `memory_store` outcomes are new|merged|superseded — dedupe is NEVER silent;
 * - `memory_update` is revision-checked (optimistic concurrency) and append-mostly: a corrected
 *   fact supersedes the old revision in ONE storage transaction (loser stays queryable);
 * - `memory_forget` = audited status tombstone (recoverable), `memory_delete` = hard purge —
 *   which currently fails loudly (`purge_unavailable`) because the storage primitive is a
 *   coordinator follow-up, never a silent fake;
 * - failures throw `ToolError`; results.ts converts them to `isError: true` results.
 */

import {
  actionFor,
  memoryContentHash,
  normalizeEntityName,
  uuidv7,
} from '@onememory/core';
import type {
  DurableMemoryType,
  EvidenceSpan,
  MemoryRecord,
  MemorySearchRequest,
  MemorySearchResponse,
} from '@onememory/core';
import { buildSessionContext, deriveSummary, estimateTokens } from '@onememory/retrieval';
import { searchRepo } from '@onememory/storage';

import type { OnememoryMcpContext } from './context';
import { ToolError } from './errors';
import { MCP_STORE_PROMPT_VERSION, MCP_UPDATE_PROMPT_VERSION } from './version';
import {
  typesForKind,
  type MemoryDecisionsInput,
  type MemoryDecisionsOutput,
  type MemoryDeleteInput,
  type MemoryFailuresInput,
  type MemoryFailuresOutput,
  type MemoryForgetInput,
  type MemoryForgetOutput,
  type MemoryGetInput,
  type MemoryGetOutput,
  type MemoryProjectContextInput,
  type MemoryProjectContextOutput,
  type MemoryRelatedInput,
  type MemoryRelatedOutput,
  type MemorySearchInput,
  type MemorySearchOutput,
  type MemorySkillsInput,
  type MemorySkillsOutput,
  type MemoryStoreInput,
  type MemoryStoreOutput,
  type MemoryUpdateInput,
  type MemoryUpdateOutput,
} from './schemas';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type RedactionRecord = { kind: string; location: string; length: number };

function nowIso(ctx: OnememoryMcpContext): string {
  return ctx.now().toISOString();
}

/** The fields every write path redacts BEFORE persisting (ADR-0007). */
interface RedactableWriteFields {
  content?: string;
  title?: string;
  subtype?: string;
  reason?: string;
  tags?: string[];
  evidence?: Array<{ excerpt: string; locator?: string }>;
  entities?: Array<{ name: string }>;
}

function redactWriteFields(ctx: OnememoryMcpContext, fields: RedactableWriteFields): {
  fields: RedactableWriteFields;
  redactions: RedactionRecord[];
} {
  const { value, redactions } = ctx.redact(fields);
  return { fields: value as RedactableWriteFields, redactions: redactions as RedactionRecord[] };
}

/** Index-entry summary: the stored summary, else the first sentence(s) of the content. */
function summaryOf(memory: {
  content_summary?: string;
  content: string;
}): string {
  return memory.content_summary !== undefined && memory.content_summary !== ''
    ? memory.content_summary
    : deriveSummary(memory.content, 160);
}

/** Conservative full-record estimate: what memory_get actually hands the model. */
function recordTokenEstimate(memory: MemoryRecord): number {
  return estimateTokens(`${memory.title ?? ''}${memory.content}${summaryOf(memory)}`);
}

/** Optimistic-concurrency gate (ADR-0010 §4). */
function checkRevision(memory: MemoryRecord, expectedRevision: string): void {
  if (memory.updated_at !== expectedRevision) {
    throw new ToolError(
      'revision_conflict',
      `revision conflict: expected ${expectedRevision} but the memory was last updated at ${memory.updated_at} — re-read (memory_get) and retry with the fresh revision`,
      { memory_id: memory.id, current_revision: memory.updated_at },
    );
  }
}

/** Build evidence spans bound to a source from caller-supplied input. */
function buildSpans(
  sourceId: string,
  evidence: ReadonlyArray<{ kind?: string; locator?: string; excerpt: string }>,
  defaultLocator: string,
): EvidenceSpan[] {
  return evidence.map((span, index) => ({
    source_id: sourceId,
    kind: (span.kind ?? 'message') as EvidenceSpan['kind'],
    locator: span.locator ?? `${defaultLocator} #${index + 1}`,
    excerpt: span.excerpt.slice(0, 200),
  }));
}

/** Resolve + bind entities for a fresh memory write (create-on-miss, idempotent on rebind). */
async function bindEntities(
  ctx: OnememoryMcpContext,
  memoryId: string,
  projectId: string | undefined,
  entities: ReadonlyArray<{ name: string; kind?: string }>,
): Promise<void> {
  if (entities.length === 0) return;
  const { store } = ctx.storage;
  const bindings: Array<{ entity_id: string; role: 'subject' | 'context' }> = [];
  for (const [index, input] of entities.entries()) {
    const normalized = normalizeEntityName(input.name);
    const existing = await store.findEntity({ project_id: projectId ?? null }, normalized);
    const entity =
      existing ??
      (await store.createEntity({
        project_id: projectId,
        kind: (input.kind ?? 'other') as Parameters<typeof store.createEntity>[0]['kind'],
        name: input.name,
      }));
    bindings.push({ entity_id: entity.id, role: index === 0 ? 'subject' : 'context' });
  }
  await store.bindMemoryEntities(memoryId, bindings);
}

/** Upsert the write's embedding so the vector channel can find it (warned, never fatal). */
async function upsertEmbedding(
  ctx: OnememoryMcpContext,
  memoryId: string,
  content: string,
  warnings: string[],
): Promise<void> {
  const embedder = ctx.embedder;
  if (embedder === undefined) return;
  try {
    const [vector] = await embedder.embed([content]);
    if (vector === undefined) throw new Error('embedder returned no vector');
    await ctx.storage.vectors.upsert(memoryId, vector);
  } catch (error) {
    // The memory IS stored; the vector channel degrades to a warning (retrieval's documented mode).
    warnings.push(
      `embedding upsert failed (vector channel will not find this memory): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// memory_search — progressive-disclosure ID-index over the retrieval engine
// ---------------------------------------------------------------------------

export async function handleMemorySearch(
  ctx: OnememoryMcpContext,
  input: MemorySearchInput,
): Promise<MemorySearchOutput> {
  const request: MemorySearchRequest = {
    query: input.query,
    ...(input.project_id !== undefined ? { project_id: ctx.resolveProjectId(input.project_id) } : {}),
    ...(input.kind !== undefined ? { types: typesForKind(input.kind) } : {}),
    ...(input.max_tokens !== undefined ? { max_tokens: input.max_tokens } : ctx.config.searchMaxTokens !== undefined ? { max_tokens: ctx.config.searchMaxTokens } : {}),
    ...(input.max_memories !== undefined ? { max_memories: input.max_memories } : {}),
    ...(input.entities !== undefined ? { entities: input.entities } : {}),
    ...(input.as_of !== undefined ? { as_of: input.as_of } : {}),
    ...(input.temporal_mode !== undefined ? { temporal_mode: input.temporal_mode } : {}),
    ...(input.include !== undefined ? { include: input.include } : {}),
    ...(input.session_id !== undefined ? { session_id: input.session_id } : {}),
    ...(input.explain !== undefined ? { explain: input.explain } : {}),
  };

  const response: MemorySearchResponse = await ctx.engine.search(request);

  // Progressive disclosure (ADR-0010 §3): the ID-index ONLY — no content bodies. The caller
  // fetches full records for selected ids via memory_get.
  const results = response.memories.map((memory) => {
    const label = memory.title !== undefined && memory.title !== '' ? memory.title : memory.summary;
    return {
      id: memory.id,
      type: memory.type,
      title: memory.title,
      summary: memory.summary,
      relevance: memory.relevance,
      status: memory.temporal.status,
      token_estimate: estimateTokens(`${memory.id} ${memory.type} ${label} ${memory.summary}`),
    };
  });

  return {
    results,
    tokens: response.tokens,
    query_understanding: {
      intent: response.query_understanding.intent,
      entities: response.query_understanding.entities.map((entity) => ({
        name: entity.name,
        ...(entity.matched_id !== undefined ? { matched_id: entity.matched_id } : {}),
      })),
      keywords: response.query_understanding.keywords,
    },
    warnings: response.warnings,
    token_estimate: results.reduce((sum, entry) => sum + entry.token_estimate, 0),
  };
}

// ---------------------------------------------------------------------------
// memory_get — full records with provenance (+ optional history / audit)
// ---------------------------------------------------------------------------

export async function handleMemoryGet(
  ctx: OnememoryMcpContext,
  input: MemoryGetInput,
): Promise<MemoryGetOutput> {
  const { store } = ctx.storage;
  const memory = await store.getMemory(input.id);
  if (memory === null) {
    throw new ToolError('not_found', `memory ${input.id} not found`, { memory_id: input.id });
  }

  const output: MemoryGetOutput = {
    memory,
    token_estimate: recordTokenEstimate(memory),
    ...(input.include_history === true
      ? { history: historyProjection(await store.historyOf(input.id)) }
      : {}),
    ...(input.include_audit === true
      ? {
          audit: (await store.listMemoryEvents(input.id)).map((event) => ({
            action: event.action,
            ...(event.from_status !== null ? { from_status: event.from_status } : {}),
            ...(event.to_status !== null ? { to_status: event.to_status } : {}),
            actor: event.actor,
            at: event.at,
          })),
        }
      : {}),
  };
  return output;
}

function historyProjection(records: MemoryRecord[]): MemoryGetOutput['history'] {
  return records.map((record) => ({
    id: record.id,
    type: record.type,
    ...(record.title !== undefined ? { title: record.title } : {}),
    content: record.content,
    status: record.status,
    valid_from: record.valid_from,
    ...(record.valid_until !== undefined ? { valid_until: record.valid_until } : {}),
    ...(record.superseded_by !== undefined ? { superseded_by: record.superseded_by } : {}),
  }));
}

// ---------------------------------------------------------------------------
// memory_store — outcome: new | merged | superseded (never silent)
// ---------------------------------------------------------------------------

export async function handleMemoryStore(
  ctx: OnememoryMcpContext,
  input: MemoryStoreInput,
): Promise<MemoryStoreOutput> {
  const { store } = ctx.storage;

  // 1. Redact BEFORE anything touches the database (ADR-0007: the write path's ingest duty).
  const { fields, redactions } = redactWriteFields(ctx, {
    content: input.content,
    title: input.title,
    subtype: input.subtype,
    tags: input.tags,
    reason: input.reason,
    evidence: input.evidence,
    entities: input.entities,
  });
  const content = fields.content ?? input.content;
  const title = fields.title;
  const subtype = fields.subtype;
  const tags = fields.tags;
  const evidence = fields.evidence ?? input.evidence;
  const entities = fields.entities ?? input.entities;

  // 2. Provenance gate (memory-model.md §6): durable memories REQUIRE source + evidence.
  if (evidence === undefined || evidence.length === 0) {
    throw new ToolError(
      'provenance_required',
      'durable memories require provenance: pass at least one evidence span (e.g. evidence: [{excerpt: "…", locator: "session.jsonl:183"}] — what supports this statement). '
        + 'Unattributable content is not durable memory (it belongs to working memory, which is not an MCP tool yet — open decision D8).',
      {},
    );
  }

  // 3. Scope resolution: explicit input > scope keyword > configured default (warned when unscoped).
  const warnings: string[] = [];
  let projectId: string | undefined;
  let userId: string | undefined;
  if (input.project_id !== undefined) {
    projectId = input.project_id;
  } else if (input.scope === 'user') {
    userId = await ctx.localUserId();
  } else if (input.scope === 'project') {
    projectId = ctx.resolveProjectId();
    if (projectId === undefined) {
      throw new ToolError(
        'project_required',
        'scope "project" needs a project id: pass project_id, or configure the server (ONEMEMORY_PROJECT_ID / config.projectId)',
        {},
      );
    }
  } else {
    projectId = ctx.resolveProjectId();
    if (projectId === undefined) {
      warnings.push('stored without project scope (no project configured) — pass project_id to scope it');
    }
  }

  // 4. Temporal validation.
  const observedAt = input.observed_at ?? nowIso(ctx);
  if (
    input.valid_from !== undefined &&
    input.valid_until !== undefined &&
    new Date(input.valid_from).getTime() >= new Date(input.valid_until).getTime()
  ) {
    throw new ToolError('invalid_window', `valid_from (${input.valid_from}) must be before valid_until (${input.valid_until})`, {});
  }

  // 5. Provenance anchor: a source row for this explicit statement.
  const source = await store.createSource({
    kind: 'explicit',
    ...(input.source_uri !== undefined ? { uri: input.source_uri } : { uri: `onemem://memory-store/${uuidv7()}` }),
    ...(input.source_title !== undefined ? { title: input.source_title } : { title: 'MCP memory_store' }),
    ...(ctx.workspaceHint !== null ? { metadata: { workspace: ctx.workspaceHint } } : {}),
    ...(projectId !== undefined ? { project_id: projectId } : {}),
  });
  const spans = buildSpans(source.id, evidence, 'onemem-mcp memory_store');

  const commonFields = {
    type: input.type,
    ...(title !== undefined && title !== '' ? { title: title.slice(0, 80) } : {}),
    ...(subtype !== undefined ? { subtype: subtype.slice(0, 120) } : {}),
    content,
    content_summary: deriveSummary(content, 160),
    importance: input.importance ?? 0.6,
    confidence: input.confidence ?? 0.7,
    observed_at: observedAt,
    ...(input.valid_from !== undefined ? { valid_from: input.valid_from } : {}),
    ...(input.valid_until !== undefined ? { valid_until: input.valid_until } : {}),
    ...(projectId !== undefined ? { project_id: projectId } : {}),
    ...(userId !== undefined ? { user_id: userId } : {}),
    agent_id: ctx.config.agentId,
    source_id: source.id,
    evidence: spans,
    extraction: { method: 'heuristic' as const, prompt_version: MCP_STORE_PROMPT_VERSION, adapter: ctx.config.agentId },
    ...(tags !== undefined ? { tags } : {}),
    token_estimate: estimateTokens(content),
  };

  // 6. The write, with the outcome contract (ADR-0010 §4).
  let outcomeMemoryId: string;
  let outcome: 'new' | 'merged' | 'superseded';
  let existingId: string | undefined;
  let supersededId: string | undefined;

  if (input.supersedes !== undefined) {
    const loser = await store.getMemory(input.supersedes);
    if (loser === null) {
      throw new ToolError('not_found', `cannot supersede: memory ${input.supersedes} not found`, {
        memory_id: input.supersedes,
      });
    }
    // Same window rule as memory_update: a superseding revision is observed after the loser's
    // window start. Explicit observed_at below that start is rejected; the defaulted "now" is
    // nudged (the fact may be back-dated but its replacement cannot precede it).
    let winnerObservedAt = observedAt;
    const loserValidFromMs = new Date(loser.valid_from).getTime();
    if (new Date(winnerObservedAt).getTime() <= loserValidFromMs) {
      if (input.observed_at !== undefined) {
        throw new ToolError(
          'invalid_window',
          `observed_at (${observedAt}) must be after the superseded memory's valid_from (${loser.valid_from})`,
          { memory_id: loser.id },
        );
      }
      winnerObservedAt = new Date(loserValidFromMs + 1).toISOString();
    }
    const result = await store.supersede({
      winner: { ...commonFields, observed_at: winnerObservedAt },
      loser_id: loser.id,
      actor: ctx.actor,
      ...(input.reason !== undefined && input.reason !== '' ? { reason: input.reason } : {}),
    });
    if (result.outcome === 'winner-duplicate') {
      // Identical content already exists: the supersession did NOT happen — say so, change nothing.
      const existing = result.existing ?? result.winner;
      outcome = 'merged';
      outcomeMemoryId = existing.id;
      existingId = existing.id;
      warnings.push(
        `supersede was a no-op: the content already exists as memory ${existing.id} (same scope + type); the memory you tried to supersede was left unchanged`,
      );
    } else {
      outcome = 'superseded';
      outcomeMemoryId = result.winner.id;
      supersededId = loser.id;
      await upsertEmbedding(ctx, result.winner.id, content, warnings);
    }
  } else {
    const duplicate = await store.findDuplicate(
      { project_id: projectId ?? null, user_id: userId ?? null },
      input.type,
      memoryContentHash(content),
    );
    if (duplicate !== null) {
      // Dedupe is never silent: report the existing memory, write nothing.
      outcome = 'merged';
      outcomeMemoryId = duplicate.id;
      existingId = duplicate.id;
      warnings.push(
        `content hash matched existing memory ${duplicate.id} (same scope + type); nothing was written — pass supersedes: "${duplicate.id}" to replace it`,
      );
    } else {
      const written = await store.insertMemory(commonFields);
      if (written.outcome === 'duplicate') {
        outcome = 'merged';
        outcomeMemoryId = written.existing?.id ?? written.memory.id;
        existingId = outcomeMemoryId;
        warnings.push('a concurrent write won the dedupe race; the existing memory is returned');
      } else {
        outcome = 'new';
        outcomeMemoryId = written.memory.id;
        await upsertEmbedding(ctx, written.memory.id, content, warnings);
      }
    }
  }

  // 7. Entity bindings + cache invalidation (mission-2 follow-up: write paths invalidate).
  await bindEntities(ctx, outcomeMemoryId, projectId, entities ?? []);
  ctx.invalidateSearchCache(projectId);

  return {
    id: outcomeMemoryId,
    outcome,
    ...(existingId !== undefined ? { existing_id: existingId } : {}),
    ...(supersededId !== undefined ? { superseded_id: supersededId } : {}),
    redactions,
    warnings,
    token_estimate: estimateTokens(content),
  };
}

// ---------------------------------------------------------------------------
// memory_update — revision-checked, append-mostly (supersede in one transaction)
// ---------------------------------------------------------------------------

export async function handleMemoryUpdate(
  ctx: OnememoryMcpContext,
  input: MemoryUpdateInput,
): Promise<MemoryUpdateOutput> {
  const { store } = ctx.storage;
  const current = await store.getMemory(input.id);
  if (current === null) {
    throw new ToolError('not_found', `memory ${input.id} not found`, { memory_id: input.id });
  }
  checkRevision(current, input.expected_revision);

  // Redact every new free-text field BEFORE persisting.
  const { fields, redactions } = redactWriteFields(ctx, {
    content: input.content,
    title: input.title,
    subtype: input.subtype,
    reason: input.reason,
    evidence: input.evidence,
  });
  const content = fields.content ?? current.content;
  const title = fields.title ?? current.title;
  const type = (input.type ?? current.type) as DurableMemoryType;
  const subtype = fields.subtype ?? current.subtype;
  const importance = input.importance ?? current.importance;
  const confidence = input.confidence ?? current.confidence;
  const tags = input.tags ?? current.tags;

  // Nothing to change at all?
  const changed =
    content !== current.content ||
    type !== current.type ||
    title !== current.title ||
    subtype !== current.subtype ||
    importance !== current.importance ||
    confidence !== current.confidence ||
    tags.join('\u{1F}') !== current.tags.join('\u{1F}') ||
    input.valid_from !== undefined ||
    input.valid_until !== undefined ||
    input.evidence !== undefined;
  if (!changed) {
    throw new ToolError('no_change', 'memory_update received nothing to change: supply content and/or the fields to revise', {
      memory_id: input.id,
    });
  }

  // Content-identical edits: no storage primitive exists for an audited in-place field update
  // (the Store port only offers insertMemory / updateMemoryStatus / supersede). Fail loudly —
  // never fake a metadata patch through a side door. Coordinator follow-up (mission-5.md).
  const contentIdentical = memoryContentHash(content) === memoryContentHash(current.content);
  const metadataOnly = contentIdentical && input.content === undefined;
  if (metadataOnly) {
    throw new ToolError(
      'metadata_only_update_unsupported',
      'metadata-only edits (title/importance/confidence/tags/window with unchanged content) are not supported by the storage layer yet — it has no audited field-update primitive. '
        + 'Either include a content change (stored as a new superseding revision), or wait for the storage follow-up. Nothing was changed.',
      { memory_id: input.id, revision: current.updated_at },
    );
  }

  // Temporal window of the new revision.
  const loserValidFromMs = new Date(current.valid_from).getTime();
  let observedAt = input.observed_at ?? nowIso(ctx);
  let observedMs = new Date(observedAt).getTime();
  if (observedMs <= loserValidFromMs) {
    if (input.observed_at !== undefined) {
      throw new ToolError(
        'invalid_window',
        `the new revision's observed_at (${observedAt}) must be after the previous revision's valid_from (${current.valid_from})`,
        { memory_id: input.id },
      );
    }
    // A back-dated fact being revised "today": nudge observed_at one ms past the window start so
    // the supersession order stays valid (the winner must be observed after the loser's start).
    observedMs = loserValidFromMs + 1;
    observedAt = new Date(observedMs).toISOString();
  }
  if (input.valid_from !== undefined && new Date(input.valid_from).getTime() <= loserValidFromMs) {
    throw new ToolError(
      'invalid_window',
      `the new revision's valid_from (${input.valid_from}) must be after the previous revision's valid_from (${current.valid_from}) — the window only moves forward`,
      { memory_id: input.id },
    );
  }
  const validFrom = input.valid_from ?? observedAt;
  if (input.valid_until !== undefined && new Date(validFrom).getTime() >= new Date(input.valid_until).getTime()) {
    throw new ToolError('invalid_window', `valid_from (${validFrom}) must be before valid_until (${input.valid_until})`, {
      memory_id: input.id,
    });
  }

  // Fresh evidence rides the old record's source; absent fresh evidence, inherit (the revision
  // is derived from the record it supersedes — same anchor, corrected statement).
  const evidenceInput = fields.evidence ?? input.evidence;
  const spans =
    evidenceInput !== undefined
      ? buildSpans(current.provenance.source.id, evidenceInput, 'onemem-mcp memory_update')
      : (current.provenance.evidence as EvidenceSpan[]);

  const warnings: string[] = [];
  const winner = {
    type,
    ...(title !== undefined && title !== '' ? { title: title.slice(0, 80) } : {}),
    ...(subtype !== undefined ? { subtype: subtype.slice(0, 120) } : {}),
    content,
    content_summary: deriveSummary(content, 160),
    importance,
    confidence,
    observed_at: observedAt,
    valid_from: validFrom,
    ...(input.valid_until !== undefined ? { valid_until: input.valid_until } : {}),
    ...(current.project_id !== undefined ? { project_id: current.project_id } : {}),
    ...(current.user_id !== undefined ? { user_id: current.user_id } : {}),
    agent_id: ctx.config.agentId,
    source_id: current.provenance.source.id,
    evidence: spans,
    extraction: { method: 'heuristic' as const, prompt_version: MCP_UPDATE_PROMPT_VERSION, adapter: ctx.config.agentId },
    tags,
    token_estimate: estimateTokens(content),
  };

  const result = await store.supersede({
    winner,
    loser_id: current.id,
    actor: ctx.actor,
    ...(input.reason !== undefined && input.reason !== '' ? { reason: input.reason } : {}),
  });

  if (result.outcome === 'winner-duplicate') {
    // The corrected content already exists as another memory — nothing changed; report honestly.
    const existing = result.existing ?? result.winner;
    throw new ToolError(
      'revision_conflict',
      `the revised content already exists as memory ${existing.id} (same scope + type) — the old revision was left completely unchanged; nothing was superseded`,
      { memory_id: input.id, existing_id: existing.id, revision: current.updated_at },
    );
  }

  await upsertEmbedding(ctx, result.winner.id, content, warnings);
  ctx.invalidateSearchCache(current.project_id);

  return {
    id: result.winner.id,
    previous_id: current.id,
    outcome: 'superseded',
    revision: result.winner.updated_at,
    redactions,
    warnings,
    token_estimate: estimateTokens(content),
  };
}

// ---------------------------------------------------------------------------
// memory_delete — hard purge (fails loudly until the storage primitive lands)
// ---------------------------------------------------------------------------

export async function handleMemoryDelete(
  ctx: OnememoryMcpContext,
  input: MemoryDeleteInput,
): Promise<never> {
  const { store } = ctx.storage;
  const memory = await store.getMemory(input.id);
  if (memory === null) {
    throw new ToolError('not_found', `memory ${input.id} not found`, { memory_id: input.id });
  }
  checkRevision(memory, input.expected_revision);

  // The Store port has no hard-delete primitive for durable memories (working memory is the only
  // deletable table, by design). Faking one is forbidden (AGENTS.md rule 3) and raw SQL outside
  // packages/storage is forbidden (rule 5) — fail loudly and leave the recoverable path available.
  throw new ToolError(
    'purge_unavailable',
    `hard purge of memory ${input.id} is not available yet: the storage layer has no deleteMemory primitive (coordinator follow-up — mission-5.md). `
      + 'NOTHING was deleted. Use memory_forget for the recoverable tombstone (status → archived, audited), or re-run this call once the primitive is merged.',
    { memory_id: input.id, revision: memory.updated_at },
  );
}

// ---------------------------------------------------------------------------
// memory_forget — soft, recoverable, audited tombstone (≠ delete)
// ---------------------------------------------------------------------------

export async function handleMemoryForget(
  ctx: OnememoryMcpContext,
  input: MemoryForgetInput,
): Promise<MemoryForgetOutput> {
  const { store } = ctx.storage;
  const memory = await store.getMemory(input.id);
  if (memory === null) {
    throw new ToolError('not_found', `memory ${input.id} not found`, { memory_id: input.id });
  }
  if (input.expected_revision !== undefined) {
    checkRevision(memory, input.expected_revision);
  }

  const { fields, redactions } = redactWriteFields(ctx, { reason: input.reason });
  const reason = fields.reason;

  const recovering = input.recover === true;
  const to = recovering ? 'active' : 'archived';
  if (recovering && memory.status !== 'archived') {
    throw new ToolError(
      'invalid_transition',
      `cannot recover: memory ${input.id} is "${memory.status}", not archived — only a forgotten (archived) memory can be recovered`,
      { memory_id: input.id, status: memory.status },
    );
  }

  let updated: MemoryRecord;
  try {
    updated = await store.updateMemoryStatus(input.id, to, {
      actor: ctx.actor,
      ...(reason !== undefined && reason !== '' ? { reason } : {}),
      details: { source: 'mcp', tool: recovering ? 'memory_forget(recover)' : 'memory_forget' },
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'InvalidTransitionError') {
      throw new ToolError(
        'invalid_transition',
        `status machine rejects ${memory.status} → ${to} for memory ${input.id}${
          !recovering && memory.status === 'archived' ? ' (already forgotten — pass recover: true to restore it)' : ''
        }: ${error.message}`,
        { memory_id: input.id, status: memory.status, target: to },
      );
    }
    throw error;
  }

  ctx.invalidateSearchCache(memory.project_id);

  return {
    id: input.id,
    status: to,
    action: recovering ? 'restored' : 'archived',
    audit: {
      action: actionFor(memory.status, to),
      from_status: memory.status,
      to_status: to,
      actor: ctx.actor,
      at: updated.updated_at,
    },
    recoverable: updated.status === 'archived',
    redactions,
    token_estimate: recordTokenEstimate(updated),
  };
}

// ---------------------------------------------------------------------------
// memory_related — the memory graph around one id
// ---------------------------------------------------------------------------

export async function handleMemoryRelated(
  ctx: OnememoryMcpContext,
  input: MemoryRelatedInput,
): Promise<MemoryRelatedOutput> {
  const { store } = ctx.storage;
  const anchor = await store.getMemory(input.id);
  if (anchor === null) {
    throw new ToolError('not_found', `memory ${input.id} not found`, { memory_id: input.id });
  }

  const atMs = ctx.now().getTime();
  const relations = input.relations !== undefined ? new Set<string>(input.relations) : undefined;
  const direction = input.direction ?? 'both';
  const max = input.max ?? 10;

  const edges = (await store.listEdges(input.id)).filter((edge) => {
    const outgoing = edge.from_memory_id === input.id;
    if (direction === 'outgoing' && !outgoing) return false;
    if (direction === 'incoming' && outgoing) return false;
    if (relations !== undefined && !relations.has(edge.relation)) return false;
    if (input.include_expired === true) return true;
    if (edge.valid_from !== null && new Date(edge.valid_from).getTime() > atMs) return false;
    if (edge.valid_until !== null && new Date(edge.valid_until).getTime() <= atMs) return false;
    return true;
  });

  const related: MemoryRelatedOutput['related'] = [];
  for (const edge of edges) {
    if (related.length >= max) break;
    const neighborId = edge.from_memory_id === input.id ? edge.to_memory_id : edge.from_memory_id;
    const neighbor = await store.getMemory(neighborId);
    if (neighbor === null) continue;
    related.push({
      memory: neighbor,
      relation: edge.relation,
      direction: edge.from_memory_id === input.id ? 'outgoing' : 'incoming',
    });
  }
  // Highest importance first — the caller's attention budget is the ranking.
  related.sort((a, b) => b.memory.importance - a.memory.importance);

  return {
    id: input.id,
    related,
    token_estimate: related.reduce((sum, entry) => sum + recordTokenEstimate(entry.memory), 0),
  };
}

// ---------------------------------------------------------------------------
// memory_project_context — the session-start channel (buildSessionContext)
// ---------------------------------------------------------------------------

export async function handleMemoryProjectContext(
  ctx: OnememoryMcpContext,
  input: MemoryProjectContextInput,
): Promise<MemoryProjectContextOutput> {
  const projectId = ctx.resolveProjectId(input.project_id);
  if (projectId === undefined) {
    throw new ToolError(
      'project_required',
      'memory_project_context needs a project: pass project_id, or configure the server (ONEMEMORY_PROJECT_ID / config.projectId)',
      {},
    );
  }
  const project = await ctx.storage.store.getProject(projectId);
  if (project === null) {
    throw new ToolError('not_found', `project ${projectId} not found`, { project_id: projectId });
  }

  const context = await buildSessionContext(
    { store: ctx.storage.store, client: ctx.storage.client },
    projectId,
    { ...(input.budget !== undefined ? { budget: input.budget } : ctx.config.sessionContextBudget !== undefined ? { budget: ctx.config.sessionContextBudget } : {}) },
  );

  return {
    project_id: context.project_id,
    budget: context.budget,
    used: context.used,
    token_estimate: context.used,
    text: context.text,
    sections: context.sections.map((section) => ({
      kind: section.kind,
      tokens: section.tokens,
      text: section.text,
    })),
    warnings: context.warnings,
  };
}

// ---------------------------------------------------------------------------
// full11: curated lists (searchRepo typed shortcuts; SQL stays in storage)
// ---------------------------------------------------------------------------

function currentFilter(ctx: OnememoryMcpContext, projectId: string, asOf?: string) {
  return {
    statuses: ['active', 'stale'] as const,
    window: { kind: 'point' as const, at: asOf ?? nowIso(ctx) },
    projectId,
  };
}

async function requireProject(ctx: OnememoryMcpContext, input: { project_id?: string }): Promise<string> {
  const projectId = ctx.resolveProjectId(input.project_id);
  if (projectId === undefined) {
    throw new ToolError(
      'project_required',
      'the curated lists are project views: pass project_id, or configure the server (ONEMEMORY_PROJECT_ID / config.projectId)',
      {},
    );
  }
  const project = await ctx.storage.store.getProject(projectId);
  if (project === null) {
    throw new ToolError('not_found', `project ${projectId} not found`, { project_id: projectId });
  }
  return projectId;
}

export async function handleMemoryDecisions(
  ctx: OnememoryMcpContext,
  input: MemoryDecisionsInput,
): Promise<MemoryDecisionsOutput> {
  const projectId = await requireProject(ctx, input);
  const candidates = await searchRepo.latestAcceptedDecisions(
    ctx.storage.client,
    { limit: input.limit ?? 10 },
    currentFilter(ctx, projectId, input.as_of),
  );

  const results = candidates.map((candidate) => ({
    id: candidate.memory.id,
    type: candidate.memory.type,
    ...(candidate.memory.title !== undefined ? { title: candidate.memory.title } : {}),
    summary: summaryOf(candidate.memory),
    relevance: 1,
    status: candidate.memory.status,
    decided_at: candidate.decided_at,
    ...(candidate.rationale !== null && candidate.rationale !== undefined ? { rationale: candidate.rationale } : {}),
    token_estimate: estimateTokens(`${candidate.memory.id} ${summaryOf(candidate.memory)}`),
  }));

  return {
    results,
    warnings: [],
    token_estimate: results.reduce((sum, entry) => sum + entry.token_estimate, 0),
  };
}

export async function handleMemoryFailures(
  ctx: OnememoryMcpContext,
  input: MemoryFailuresInput,
): Promise<MemoryFailuresOutput> {
  const projectId = await requireProject(ctx, input);
  const candidates = await searchRepo.recentFailures(
    ctx.storage.client,
    { limit: input.limit ?? 10 },
    currentFilter(ctx, projectId, input.as_of),
  );

  const results = candidates.map((candidate) => ({
    id: candidate.memory.id,
    type: candidate.memory.type,
    ...(candidate.memory.title !== undefined ? { title: candidate.memory.title } : {}),
    summary: summaryOf(candidate.memory),
    relevance: 1,
    status: candidate.memory.status,
    failure_status: candidate.failure_status,
    ...(candidate.solution !== null && candidate.solution !== undefined ? { solution: candidate.solution } : {}),
    occurrence_count: candidate.occurrence_count,
    last_seen_at: candidate.last_seen_at,
    token_estimate: estimateTokens(`${candidate.memory.id} ${summaryOf(candidate.memory)}`),
  }));

  return {
    results,
    warnings: [],
    token_estimate: results.reduce((sum, entry) => sum + entry.token_estimate, 0),
  };
}

export async function handleMemorySkills(
  ctx: OnememoryMcpContext,
  input: MemorySkillsInput,
): Promise<MemorySkillsOutput> {
  const projectId = await requireProject(ctx, input);
  // Skills are promoted procedural memories (memory-model.md §2/§9); the standalone skills
  // payload table fills in when the skillify stage (M7) lands.
  const records = await searchRepo.listCurrentMemories(
    ctx.storage.client,
    { types: ['procedural'], order: 'importance', limit: input.limit ?? 10 },
    currentFilter(ctx, projectId),
  );

  const results = records.map((memory) => ({
    id: memory.id,
    type: memory.type,
    ...(memory.subtype !== undefined ? { name: memory.subtype } : {}),
    ...(memory.title !== undefined ? { title: memory.title } : {}),
    summary: summaryOf(memory),
    relevance: 1,
    status: memory.status,
    token_estimate: estimateTokens(`${memory.id} ${summaryOf(memory)}`),
  }));

  return {
    results,
    warnings: [],
    token_estimate: results.reduce((sum, entry) => sum + entry.token_estimate, 0),
  };
}

// ---------------------------------------------------------------------------
// The registry: every profile tool's handler, keyed by name (server.ts binds these)
// ---------------------------------------------------------------------------

/**
 * The heterogeneous-handler dispatcher type. Parameter contravariance makes each precise
 * `(ctx, args: SpecificInput)` handler assignable here without casts: `never` is assignable to
 * every input type. The registerTool wrapper re-validates args through the tool's input schema
 * before invoking, so the narrowed types hold at runtime.
 */
export type AnyToolHandler = (ctx: OnememoryMcpContext, args: never) => Promise<unknown>;

export const TOOL_HANDLERS: Readonly<Record<import('./schemas').ToolName, AnyToolHandler>> = {
  memory_search: handleMemorySearch,
  memory_get: handleMemoryGet,
  memory_store: handleMemoryStore,
  memory_update: handleMemoryUpdate,
  memory_delete: handleMemoryDelete,
  memory_forget: handleMemoryForget,
  memory_related: handleMemoryRelated,
  memory_project_context: handleMemoryProjectContext,
  memory_decisions: handleMemoryDecisions,
  memory_failures: handleMemoryFailures,
  memory_skills: handleMemorySkills,
};
