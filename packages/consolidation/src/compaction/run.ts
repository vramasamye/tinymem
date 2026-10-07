/**
 * `runEventsCompaction` — the M14.6 events-compaction pass: one callable, deterministic entry
 * over the `EventsCompactor` port (core declares the port; storage is the only package with
 * SQL). Bounded, idempotent, safe to schedule:
 *
 *   - bounded: each run scans at most `maxEventsPerRun` candidates in `batchLimit` batches, and
 *     every batch applies as ONE transaction (digest insert + raw delete together — a purge can
 *     never commit without its summary);
 *   - idempotent: digests are unique on `event_id` (conflicts are no-ops) and the keyset cursor
 *     visits each row at most once per pass, so a second run within the same windows changes
 *     nothing (verified by test);
 *   - deterministic: the decision is the pure planner (`plan.ts`); this loop only feeds it.
 *
 * What compacts: the raw `events` log ONLY. The `memory_events` audit trail stays append-only
 * (ADR-0007 rule 6) and `sources` rows are never touched — memory-model.md §6 keeps sources as
 * the durable anchors that "are retained even if the raw event payload is compacted".
 *
 * `dryRun: true` prints the typed plan without mutating anything (the CLI's `--dry-run`).
 */

import type {
  CompactionCursor,
  CompactionPlanEntry,
  EventsCompactor,
  EventsCompactionConfigInput,
  EventsCompactionReport,
  NewEventDigest,
  StoredEvent,
} from '@onememory-ai/core';
import { resolveEventsCompactionConfig } from '@onememory-ai/core';

import { errorMessage } from '../util';
import { compactionCutoffs, planBatch } from './plan';
import { buildEventDigest } from './summary';

/** What `runEventsCompaction` needs. Everything but the compactor is optional. */
export interface EventsCompactionInput {
  /** The storage port implementation (`createEventsCompactor(db)` from `@onememory-ai/storage`). */
  compactor: EventsCompactor;
  /** Project scope: a project id compacts one project; `undefined` compacts every scope. */
  scope?: { project_id?: string };
  /** Injectable clock (tests / deterministic runs). */
  now?: () => Date;
  /** Classify only — print the plan, mutate nothing. */
  dryRun?: boolean;
  /** The two windows (`summaryWindowDays`, `retentionWindowDays`) + batch bounds. */
  config?: EventsCompactionConfigInput;
}

export async function runEventsCompaction(
  input: EventsCompactionInput,
): Promise<EventsCompactionReport> {
  const config = resolveEventsCompactionConfig(input.config);
  const clock = input.now ?? (() => new Date());
  const ranAt = clock();
  const cutoffs = compactionCutoffs(ranAt, config.summaryWindowDays, config.retentionWindowDays);
  const dryRun = input.dryRun === true;
  const warnings: string[] = [];

  // The typed plan accumulates across batches: counts are exact; entries/blocked are capped
  // samples (planEntryLimit) — the plan is counts first, detail second.
  const plan: EventsCompactionReport['plan'] = {
    summary_cutoff: cutoffs.summaryCutoff,
    retention_cutoff: cutoffs.retentionCutoff,
    to_summarize: 0,
    to_purge: 0,
    kept: 0,
    entries: [],
    blocked: [],
  };
  const blockedCounts = new Map<string, number>();
  let entriesCapped = false;
  let blockedCapped = false;

  let considered = 0;
  let summarized = 0;
  let purged = 0;
  let batches = 0;
  let truncated = false;
  let cursor: CompactionCursor | undefined;

  scan: while (considered < config.maxEventsPerRun) {
    const limit = Math.min(config.batchLimit, config.maxEventsPerRun - considered);
    let batch: StoredEvent[] | undefined;
    try {
      batch = await input.compactor.listCompactableEvents({
        olderThan: cutoffs.summaryCutoff,
        limit,
        ...(input.scope === undefined ? {} : { scope: input.scope }),
        ...(cursor === undefined ? {} : { after: cursor }),
      });
    } catch (error) {
      warnings.push(`compaction scan failed: ${errorMessage(error)}`);
      break scan;
    }
    if (batch.length === 0) break scan;

    considered += batch.length;
    const last = batch[batch.length - 1]!;
    cursor = { occurred_at: last.occurred_at, id: last.id };

    // --- the pure decision -----------------------------------------------------
    const digestedIds = await input.compactor.digestedEventIds(batch.map((event) => event.id));
    const planned = planBatch(batch, digestedIds, cutoffs);
    plan.to_summarize += planned.toSummarize;
    plan.to_purge += planned.toPurge;
    plan.kept += planned.kept;
    for (const entry of planned.entries) {
      if (entry.action !== 'keep') {
        if (plan.entries.length < config.planEntryLimit) plan.entries.push(entry);
        else entriesCapped = true;
      }
    }
    for (const entry of planned.blocked) {
      blockedCounts.set(entry.reason, (blockedCounts.get(entry.reason) ?? 0) + 1);
      if (plan.blocked.length < config.planEntryLimit) plan.blocked.push(entry);
      else blockedCapped = true;
    }

    // --- the execution (one transaction per batch; skipped whole in a dry run) --
    if (!dryRun && (planned.toSummarize > 0 || planned.toPurge > 0)) {
      try {
        const batchPlan = await applyBatch(input.compactor, batch, planned.entries);
        summarized += batchPlan.summarized;
        purged += batchPlan.purged;
        batches += 1;
      } catch (error) {
        warnings.push(`compaction batch failed (rolled back): ${errorMessage(error)}`);
        break scan;
      }
    }

    if (batch.length < limit) break scan;
    if (considered >= config.maxEventsPerRun) truncated = true;
  }

  // --- the honest tail: blocked purges, caps, truncation — never silent -----------
  for (const [reason, count] of blockedCounts) {
    warnings.push(
      `${count} raw event${count === 1 ? '' : 's'} older than the retention window ` +
        `kept: ${reason}`,
    );
  }
  if (entriesCapped || blockedCapped) {
    warnings.push(`plan detail capped at ${config.planEntryLimit} entries — the counts stay exact`);
  }
  if (truncated) {
    warnings.push(
      `the scan visited ${considered} candidates (the per-run cap) — older events await the ` +
        'next pass (compaction is idempotent)',
    );
  }

  const rawEventsRemaining = await input.compactor.countRawEvents(input.scope);

  return {
    ran_at: ranAt.toISOString(),
    dry_run: dryRun,
    scope: { project_id: input.scope?.project_id ?? null },
    windows: {
      summary_window_days: config.summaryWindowDays,
      retention_window_days: config.retentionWindowDays,
    },
    plan,
    summarized,
    purged,
    raw_events_remaining: rawEventsRemaining,
    batches,
    considered,
    truncated,
    warnings,
  };
}

/** Apply one batch: build the digest rows (with their source linkage), then one transaction. */
async function applyBatch(
  compactor: EventsCompactor,
  events: readonly StoredEvent[],
  entries: readonly CompactionPlanEntry[],
): Promise<{ summarized: number; purged: number }> {
  const byId = new Map(events.map((event) => [event.id, event] as const));
  const summarizeIds = entries
    .filter((entry) => entry.action === 'summarize' || entry.action === 'summarize_and_purge')
    .map((entry) => entry.event_id);
  const purgeIds = entries
    .filter((entry) => entry.action === 'purge' || entry.action === 'summarize_and_purge')
    .map((entry) => entry.event_id);

  let digests: NewEventDigest[] = [];
  if (summarizeIds.length > 0) {
    const sources = await compactor.sourcesForEvents(summarizeIds);
    digests = summarizeIds.flatMap((eventId) => {
      const event = byId.get(eventId);
      if (event === undefined) return [];
      return [buildEventDigest(event, sources.get(eventId) ?? [])];
    });
  }

  return compactor.applyCompaction({
    digests,
    purgeEventIds: purgeIds,
  });
}
