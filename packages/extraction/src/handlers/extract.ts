/**
 * EXTRACT job handler factory (memory-model.md §8 stages 4–6, 9) — exported for M13's daemon
 * wiring; this package never registers job kinds itself.
 *
 * Flow per pending-event batch:
 *   pending events (Store port) → group by project/session → provenance anchors (`sources`)
 *   → EXTRACT (heuristic or LLM) → CLASSIFY (type/subtype, working-vs-durable)
 *   → exact-dedupe probe (`findDuplicate`) → STORE (`insertMemory` / `insertWorking`, audited by
 *   the repository) → mark events processed → enqueue `re_embed` for the new memories.
 *
 * Honesty rules:
 * - an extractor failure propagates: the job fails and is retried with backoff; events of the
 *   failing group are **not** marked processed;
 * - a malformed stored event is flagged `needs_review`, never dropped;
 * - `re_embed` is enqueued only when something was actually stored, and the job kind is
 *   registered by the daemon — until then the worker fails it loudly (`JobKindNotImplemented`).
 */

import {
  estimateTokens,
  memoryContentHash,
  type DurableMemoryType,
  type EvidenceSpan,
  type ExtractedMemory,
  type ExtractionInput,
  type ExtractionResult,
  type Extractor,
  type JobQueue,
  type SourceRef,
  type Store,
  type StoredEvent,
} from '@onememory-ai/core';

import type { Classifier } from '../classifier';
import { normalizeEvent, sourceKindForEvent, storedEventToEnvelope } from '../events';
import { storePayloadFor } from '../enrichment/store-payload';
import { NormalizationError } from '../types';

export interface ExtractJobLike {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
}

export interface ExtractHandlerOptions {
  /** Pending events per run (default 25). */
  maxEvents?: number;
  /** Enqueue `re_embed` for newly stored memories (default true). */
  enqueueReEmbed?: boolean;
  /** Items per `re_embed` job (default 200). */
  reEmbedBatchSize?: number;
  /** Working-memory TTL from the last observed event (default 24 h). */
  workingTtlHours?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => string;
}

export interface ExtractHandlerResult {
  events_processed: number;
  memories_inserted: number;
  duplicates: number;
  working_inserted: number;
  candidates_discarded: number;
  needs_review: number;
  re_embed_jobs: number;
}

function sourceKindForGroup(events: readonly StoredEvent[]): SourceRef['kind'] {
  if (events.some((event) => event.kind.startsWith('conversation.'))) return 'conversation';
  return sourceKindForEvent(events[0]?.kind ?? 'raw.unknown');
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export function createExtractHandler(
  store: Store,
  jobs: JobQueue,
  extractor: Extractor,
  classifier: Classifier,
  options: ExtractHandlerOptions = {},
): (job: ExtractJobLike) => Promise<ExtractHandlerResult> {
  const maxEvents = options.maxEvents ?? 25;
  const enqueueReEmbed = options.enqueueReEmbed ?? true;
  const reEmbedBatchSize = Math.max(1, options.reEmbedBatchSize ?? 200);
  const workingTtlHours = options.workingTtlHours ?? 24;
  const now = options.now ?? (() => new Date().toISOString());

  return async function handleExtract(job: ExtractJobLike): Promise<ExtractHandlerResult> {
    const result: ExtractHandlerResult = {
      events_processed: 0,
      memories_inserted: 0,
      duplicates: 0,
      working_inserted: 0,
      candidates_discarded: 0,
      needs_review: 0,
      re_embed_jobs: 0,
    };

    const pending = await store.listPendingEvents(maxEvents);
    const scoped = job.payload.event_ids;
    let targets = pending;
    if (scoped !== undefined) {
      if (!Array.isArray(scoped)) {
        throw new NormalizationError(
          `extract job ${job.id} has an invalid event_ids payload`,
          job.id,
        );
      }
      const wanted = new Set(scoped.filter((value): value is string => typeof value === 'string'));
      targets = pending.filter((event) => wanted.has(event.id));
    }
    if (targets.length === 0) return result;

    // Group by project + session so one `sources` row anchors the whole group's evidence spans.
    const groups = new Map<string, StoredEvent[]>();
    for (const event of targets) {
      const key = `${event.project_id ?? 'global'}|${event.session_id ?? 'none'}|${event.runtime}`;
      const list = groups.get(key);
      if (list) list.push(event);
      else groups.set(key, [event]);
    }

    const reEmbedItems: Array<{ memory_id: string; text: string }> = [];

    for (const events of groups.values()) {
      const first = events[0]!;
      const source = await store.createSource({
        kind: sourceKindForGroup(events),
        uri: first.session_id
          ? `session/${first.session_id}`
          : `event-batch/${first.project_id ?? 'global'}/${first.id}`,
        title: first.session_id ? `agent session ${first.session_id}` : `event batch ${first.id}`,
        ...(first.project_id === undefined ? {} : { project_id: first.project_id }),
      });

      const inputs: ExtractionInput[] = [];
      for (const stored of events) {
        try {
          inputs.push({ event: storedEventToEnvelope(stored), source });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await store.markEventProcessed(stored.id, { needs_review: true, process_error: message });
          result.needs_review += 1;
        }
      }
      if (inputs.length === 0) continue;

      // Extractor failure is fatal for this run (retry with backoff); nothing is marked processed.
      const extraction: ExtractionResult = await extractor.extract(inputs);
      const occurredAt = new Map(inputs.map((input) => [input.event.id, input.event.occurred_at]));
      const normalized = inputs.map(normalizeEvent);

      for (const candidate of extraction.memories) {
        const classified = classifier.classify(candidate);
        const scope = {
          project_id: first.project_id ?? null,
          user_id: first.user_id ?? null,
        };
        const duplicate = await store.findDuplicate(
          scope,
          classified.durable_type as DurableMemoryType,
          memoryContentHash(candidate.content),
        );
        if (duplicate) {
          result.duplicates += 1;
          continue;
        }

        const observedAt = observedAtFor(candidate, occurredAt) ?? first.occurred_at;
        const payload = storePayloadFor(candidate, normalized, observedAt);
        const write = await store.insertMemory({
          ...(payload === undefined ? {} : { payload }),
          type: classified.durable_type,
          ...(classified.subtype === undefined ? {} : { subtype: classified.subtype }),
          ...(candidate.title === undefined ? {} : { title: candidate.title }),
          content: candidate.content,
          ...(candidate.content.length > 160
            ? { content_summary: candidate.content.slice(0, 159) }
            : {}),
          importance: candidate.importance,
          confidence: candidate.confidence,
          observed_at: observedAt,
          valid_from: candidate.valid_from ?? observedAt,
          ...(candidate.valid_until === undefined ? {} : { valid_until: candidate.valid_until }),
          ...(first.project_id === undefined ? {} : { project_id: first.project_id }),
          ...(first.user_id === undefined ? {} : { user_id: first.user_id }),
          ...(first.agent_id === undefined ? {} : { agent_id: first.agent_id }),
          source_id: source.id,
          evidence: candidate.evidence,
          extraction: {
            method: extraction.extraction_meta.method,
            ...(extraction.extraction_meta.model === undefined
              ? {}
              : { model: extraction.extraction_meta.model }),
            prompt_version: extraction.extraction_meta.prompt_version,
            adapter: 'extraction',
            ...(first.session_id === undefined ? {} : { session_id: first.session_id }),
          },
          tags: [
            'extracted',
            ...(classified.awaiting_consolidation ? ['semantic_candidate'] : []),
          ],
          token_estimate: estimateTokens(candidate.content),
        });

        if (write.outcome === 'duplicate') {
          result.duplicates += 1;
          continue;
        }
        result.memories_inserted += 1;
        reEmbedItems.push({
          memory_id: write.memory.id,
          text: `${candidate.title ?? ''} ${candidate.content}`.trim(),
        });
      }

      const expiresAt = new Date(
        Math.max(Date.parse(now()), Date.parse(lastOccurredAt(inputs))) + workingTtlHours * 3_600_000,
      ).toISOString();

      for (const candidate of extraction.working) {
        const normalized = classifier.normalizeWorking(candidate);
        if (!normalized) {
          result.candidates_discarded += 1;
          continue;
        }
        // `createSession` is an upsert: safe to call per batch, and `working_memory.session_id`
        // has an FK to `sessions`.
        await store.createSession({
          id: normalized.session_id,
          ...(first.project_id === undefined ? {} : { project_id: first.project_id }),
          ...(first.agent_id === undefined ? {} : { agent_id: first.agent_id }),
          runtime: first.runtime,
          started_at: first.occurred_at,
        });
        await store.insertWorking({
          session_id: normalized.session_id,
          kind: normalized.kind,
          content: normalized.content,
          source_id: source.id,
          evidence: [],
          expires_at: expiresAt,
        });
        result.working_inserted += 1;
      }

      for (const input of inputs) {
        await store.markEventProcessed(input.event.id);
        result.events_processed += 1;
      }
    }

    if (enqueueReEmbed && reEmbedItems.length > 0) {
      const batches = chunk(reEmbedItems, reEmbedBatchSize);
      for (let index = 0; index < batches.length; index += 1) {
        const items = batches[index]!;
        await jobs.enqueue({
          kind: 're_embed',
          key: `re_embed:${items[0]!.memory_id}`,
          payload: {
            reason: 'backfill',
            batch_index: index,
            batch_total: batches.length,
            items,
          },
        });
        result.re_embed_jobs += 1;
      }
    }

    return result;
  };
}

function lastOccurredAt(inputs: readonly ExtractionInput[]): string {
  let latest = inputs[0]?.event.occurred_at ?? new Date().toISOString();
  for (const input of inputs) {
    if (input.event.occurred_at > latest) latest = input.event.occurred_at;
  }
  return latest;
}

/**
 * `observed_at` for a candidate: the earliest event it cites. Locators are `event:<id>` /
 * `commit:<sha>`; commit locators fall back to the group's earliest event.
 */
function observedAtFor(
  candidate: ExtractedMemory,
  occurredAt: ReadonlyMap<string, string>,
): string | undefined {
  let earliest: string | undefined;
  for (const span of candidate.evidence as EvidenceSpan[]) {
    const id = span.locator.startsWith('event:') ? span.locator.slice('event:'.length) : undefined;
    const value = id === undefined ? undefined : occurredAt.get(id);
    if (value !== undefined && (earliest === undefined || value < earliest)) earliest = value;
  }
  return earliest;
}
