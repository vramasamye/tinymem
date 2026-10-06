/**
 * The compaction planner — the PURE decision of which raw `events` rows to summarize vs. purge
 * (M14.6, AC 1). No SQL, no clock reads, no side effects: given the candidate rows, the set of
 * already-digested ids, and the two windows, it classifies every event with an action and a
 * reason. `runEventsCompaction` (run.ts) is the executing orchestrator that feeds batches
 * through this function; tests target the classification matrix directly.
 *
 * Decision rules (database-schema.md §6 "summarize first, purge after the summary is written"):
 *   summarize          — older than the summary window, no digest yet (raw row kept: it is
 *                         younger than the retention window; the digest is a preview)
 *   summarize_and_purge— older than the retention window, pipeline-clean, no digest yet (the
 *                         digest insert and the raw delete share one transaction)
 *   purge              — older than the retention window, pipeline-clean, digest already exists
 *   keep               — young, already summarized and awaiting the retention window, or
 *                         BLOCKED: the pipeline never processed it, flagged it needs_review,
 *                         or errored on it. Blocked events are never silently retained — the
 *                         report carries the reason.
 *
 * `retentionWindowDays = 0` means keep forever: nothing is ever purged (the architecture's
 * "0 = keep forever"), while the summarize tier still runs at its own window.
 */

import type { StoredEvent } from '@onememory/core';
import type {
  CompactionKeepReason,
  CompactionPlanEntry,
} from '@onememory/core';

const DAY_MS = 86_400_000;

/** The ISO cutoffs both the SQL scan and this planner share. */
export interface CompactionCutoffs {
  /** Events with occurred_at before this get a digest (now − summaryWindowDays). */
  summaryCutoff: string;
  /** Events with occurred_at before this get purged; `null` when retention is `0` (keep forever). */
  retentionCutoff: string | null;
}

/** Derive the cutoffs from the injected clock and the two windows (pure). */
export function compactionCutoffs(
  now: Date,
  summaryWindowDays: number,
  retentionWindowDays: number,
): CompactionCutoffs {
  const summaryCutoff = new Date(now.getTime() - summaryWindowDays * DAY_MS).toISOString();
  const retentionCutoff =
    retentionWindowDays === 0
      ? null
      : new Date(now.getTime() - retentionWindowDays * DAY_MS).toISOString();
  return { summaryCutoff, retentionCutoff };
}

function before(at: string, cutoff: string | null): boolean {
  if (cutoff === null) return false;
  return Date.parse(at) < Date.parse(cutoff);
}

/** Classify one raw event (pure — the planner's atom). */
export function classifyEvent(
  event: StoredEvent,
  digested: boolean,
  cutoffs: CompactionCutoffs,
): CompactionPlanEntry {
  const base = { event_id: event.id, kind: event.kind, occurred_at: event.occurred_at };

  if (!before(event.occurred_at, cutoffs.retentionCutoff)) {
    // Younger than the retention window: summarize at most, never purge.
    if (before(event.occurred_at, cutoffs.summaryCutoff)) {
      return digested
        ? { ...base, action: 'keep', reason: 'already summarized — awaiting the retention window' }
        : { ...base, action: 'summarize', reason: 'older than the summary window' };
    }
    return { ...base, action: 'keep', reason: 'within the summary window' };
  }

  // Older than the retention window: purge only when the pipeline finished cleanly — the raw
  // row is the pipeline's remaining work order for anything it never consumed or flagged.
  const keepReason: CompactionKeepReason | null =
    event.processed_at === undefined ? 'unprocessed'
    : event.needs_review ? 'needs_review'
    : event.process_error !== undefined ? 'process_error'
    : null;
  if (keepReason !== null) {
    return { ...base, action: 'keep', reason: keepReason };
  }
  return digested
    ? { ...base, action: 'purge', reason: 'older than the retention window, summary exists' }
    : {
        ...base,
        action: 'summarize_and_purge',
        reason: 'older than the retention window, pipeline-clean',
      };
}

/** The blocked-keep reasons — the keeps an operator must hear about, never silently retained. */
const BLOCKED_REASONS: ReadonlySet<string> = new Set<CompactionKeepReason>([
  'unprocessed',
  'needs_review',
  'process_error',
]);

/** One planned batch: the full classification plus the counts the report carries. */
export interface BatchPlan {
  entries: CompactionPlanEntry[];
  /** Events that still need a digest row (`summarize` + `summarize_and_purge`). */
  toSummarize: number;
  /** Raw rows to delete (`summarize_and_purge` + `purge`). */
  toPurge: number;
  /** Events left untouched, whatever the reason. */
  kept: number;
  /** The blocked keeps (`unprocessed` / `needs_review` / `process_error`), in scan order. */
  blocked: CompactionPlanEntry[];
}

/** Classify a batch of candidate events (pure — the entry point `runEventsCompaction` feeds). */
export function planBatch(
  events: readonly StoredEvent[],
  digestedIds: ReadonlySet<string>,
  cutoffs: CompactionCutoffs,
): BatchPlan {
  const entries: CompactionPlanEntry[] = [];
  const blocked: CompactionPlanEntry[] = [];
  let toSummarize = 0;
  let toPurge = 0;
  let kept = 0;
  for (const event of events) {
    const entry = classifyEvent(event, digestedIds.has(event.id), cutoffs);
    entries.push(entry);
    if (entry.action === 'summarize' || entry.action === 'summarize_and_purge') toSummarize += 1;
    if (entry.action === 'purge' || entry.action === 'summarize_and_purge') toPurge += 1;
    if (entry.action === 'keep') {
      kept += 1;
      if (BLOCKED_REASONS.has(entry.reason)) blocked.push(entry);
    }
  }
  return { entries, toSummarize, toPurge, kept, blocked };
}
