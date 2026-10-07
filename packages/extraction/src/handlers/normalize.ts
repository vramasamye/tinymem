/**
 * NORMALIZE job handler factory (memory-model.md §8 stage 3) — exported for M13's daemon wiring.
 *
 * "Raw events → clean text/structured forms (terminal output parsing, diff parsing …). Normalize
 * failure marks event `needs_review`, never drops it."
 *
 * Implementation notes:
 * - the pure transformation lives in `../events.ts`; this handler is the pipeline stage that runs
 *   it over pending events, creates the provenance anchors evidence spans will reference, flags
 *   unparseable events `needs_review`, and hands the batch to EXTRACT through the job queue;
 * - M1's `events` table has no `normalized` column, so the normalized batch travels in the
 *   `extract` job payload (`jobs.payload`, jsonb). Documented deviation: a later migration may add
 *   `events.normalized jsonb` or a `normalized_events` table (owned by the coordinating session).
 */

import { z } from 'zod';
import type { JobQueue, SourceKind, Store, StoredEvent } from '@onememory-ai/core';

import {
  NormalizedBatchSchema,
  normalizeEvent,
  sourceKindForEvent,
  storedEventToEnvelope,
  type NormalizedEvent,
} from '../events';
import { NormalizationError } from '../types';

export interface NormalizeJobLike {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
}

export interface NormalizeHandlerOptions {
  /** Pending events considered per run (default 50). */
  maxEvents?: number;
  /** Enqueue the downstream `extract` job (default true). */
  enqueueExtract?: boolean;
}

export interface NormalizeHandlerResult {
  normalized: number;
  needs_review: number;
  extract_jobs: number;
  event_ids: string[];
}

const EventIdsSchema = z.array(z.uuid()).min(1);

function sourceKindForGroup(events: readonly StoredEvent[]): SourceKind {
  if (events.some((event) => event.kind.startsWith('conversation.'))) return 'conversation';
  return sourceKindForEvent(events[0]?.kind ?? 'raw.unknown');
}

/**
 * Create the `normalize` handler. `store` supplies the raw event log and the provenance anchors;
 * `jobs` receives the downstream `extract` job.
 */
export function createNormalizeHandler(
  store: Store,
  jobs: JobQueue,
  options: NormalizeHandlerOptions = {},
): (job: NormalizeJobLike) => Promise<NormalizeHandlerResult> {
  const maxEvents = options.maxEvents ?? 50;
  const enqueueExtract = options.enqueueExtract ?? true;

  return async function handleNormalize(job: NormalizeJobLike): Promise<NormalizeHandlerResult> {
    const pending = await store.listPendingEvents(maxEvents);

    // The payload may scope the batch to specific events (still read through the port's pending
    // listing — the Store port has no getEvent, and a scoped id that is no longer pending is
    // simply already processed).
    let targets = pending;
    if (job.payload.event_ids !== undefined) {
      const parsed = EventIdsSchema.safeParse(job.payload.event_ids);
      if (!parsed.success) {
        throw new NormalizationError(
          `normalize job ${job.id} has an invalid event_ids payload`,
          job.id,
          { cause: parsed.error },
        );
      }
      const wanted = new Set(parsed.data);
      targets = pending.filter((event) => wanted.has(event.id));
    }

    const result: NormalizeHandlerResult = {
      normalized: 0,
      needs_review: 0,
      extract_jobs: 0,
      event_ids: [],
    };
    if (targets.length === 0) return result;

    // One provenance anchor per (project, session) group — the `sources` row evidence spans cite.
    const groups = new Map<string, StoredEvent[]>();
    for (const event of targets) {
      const key = `${event.project_id ?? 'global'}|${event.session_id ?? 'none'}`;
      const list = groups.get(key);
      if (list) list.push(event);
      else groups.set(key, [event]);
    }

    const normalizedBatch: NormalizedEvent[] = [];
    for (const [key, events] of groups) {
      const first = events[0]!;
      const sessionId = first.session_id;
      const source = await store.createSource({
        kind: sourceKindForGroup(events),
        uri: sessionId
          ? `session/${sessionId}`
          : `event-batch/${first.project_id ?? 'global'}/${first.id}`,
        title: sessionId ? `agent session ${sessionId}` : `event batch ${key}`,
        ...(first.project_id === undefined ? {} : { project_id: first.project_id }),
      });

      for (const stored of events) {
        try {
          const envelope = storedEventToEnvelope(stored);
          normalizedBatch.push(normalizeEvent({ event: envelope, source }));
          result.normalized += 1;
        } catch (error) {
          // Never drop: flag for review, record why, and continue with the rest of the batch.
          const message = error instanceof Error ? error.message : String(error);
          await store.markEventProcessed(stored.id, {
            needs_review: true,
            process_error: message,
          });
          result.needs_review += 1;
        }
      }
    }

    if (enqueueExtract && normalizedBatch.length > 0) {
      const eventIds = normalizedBatch.map((event) => event.event_id);
      await jobs.enqueue({
        kind: 'extract',
        key: `extract:${eventIds[0]}`,
        payload: { event_ids: eventIds, normalized: normalizedBatch },
      });
      result.extract_jobs = 1;
      result.event_ids = eventIds;
    }

    return result;
  };
}

/** Validate a normalized batch read back from a job payload. */
export function parseNormalizedBatch(value: unknown): NormalizedEvent[] {
  const parsed = NormalizedBatchSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}
