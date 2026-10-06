/**
 * Retention types — the M14.6 events-compaction contract (backlog §M14.6; database-schema.md
 * §6 "Events table compaction": raw payloads older than the retention window are summarized
 * and purged — evidence spans survive, raw chatter doesn't).
 *
 * What compacts: the RAW event log (`events`) — the append-only `memory_events` audit trail is
 * NEVER compacted (ADR-0007 rule 6: it is the append-only audit of every state change, and
 * database-schema.md §6 keeps it as the record of every transition). The summary lives in the
 * `memory_events_digest` table (one digest row per raw event, unique on `event_id`) so the
 * `event:<id>` evidence-span locators stay resolvable after the raw row is purged, and the
 * `sources` rows — the durable provenance anchors — stay untouched (memory-model.md §6:
 * sources are "retained even if the raw event payload is compacted").
 *
 * Who codes against what (repository-structure.md): core declares this file; storage implements
 * the `EventsCompactor` port (the only package with SQL); consolidation orchestrates the pass
 * (`runEventsCompaction`); the CLI and a future daemon scheduler call the orchestrator.
 */

import { z } from 'zod';

import type { StoredEvent } from '../ports/records';

// ---------------------------------------------------------------------------
// Windows & defaults
// ---------------------------------------------------------------------------

/**
 * Days a raw event keeps its full payload before a digest summary is written. Older than this
 * and younger than the retention window: summarized, raw row kept (the summary is a preview,
 * not a substitute). Non-destructive, so the floor is small.
 */
export const DEFAULT_SUMMARY_WINDOW_DAYS = 30;

/**
 * Days a raw event survives at all. Older than this (and processed cleanly): the raw row is
 * deleted — its digest row is the surviving lineage record. The default is the architecture's
 * normative 90 (database-schema.md §6 "raw payloads older than N days (default 90)").
 * `0` means "keep forever" (the summarize tier still runs at its own window).
 */
export const DEFAULT_RETENTION_WINDOW_DAYS = 90;

/** The summarize tier is never disabled by a zero window — use retention `0` to disable purging. */
export const MIN_SUMMARY_WINDOW_DAYS = 1;

/** Raw events fetched per scan batch (each batch applies as one transaction). */
export const DEFAULT_COMPACTION_BATCH = 500;
export const MAX_COMPACTION_BATCH = 2000;

/** The one-run scan cap — compaction is bounded work, safe to schedule repeatedly. */
export const DEFAULT_COMPACTION_MAX_EVENTS = 5000;
export const MAX_COMPACTION_MAX_EVENTS = 100_000;

/** Per-entry detail the typed plan carries (the plan is counts first, samples second). */
export const DEFAULT_COMPACTION_PLAN_ENTRIES = 100;
export const MAX_COMPACTION_PLAN_ENTRIES = 1000;

// ---------------------------------------------------------------------------
// Configuration (Zod at the boundary — the library entry and the CLI both pass through here)
// ---------------------------------------------------------------------------

export const EventsCompactionConfigSchema = z
  .looseObject({
    /** Days before a raw event is summarized into `memory_events_digest` (≥ 1). */
    summaryWindowDays: z
      .number()
      .int()
      .min(
        MIN_SUMMARY_WINDOW_DAYS,
        `summaryWindowDays must be at least ${MIN_SUMMARY_WINDOW_DAYS} — a zero summary window ` +
          'means "summarize nothing", which also blocks purging (a purge requires its summary ' +
          'first). To disable compaction entirely, set retentionWindowDays to 0 (keep forever)',
      )
      .optional(),
    /** Days a raw event is kept; `0` = keep forever (database-schema.md §6). */
    retentionWindowDays: z.number().int().min(0).optional(),
    /** Scan batch size (one transaction per batch). */
    batchLimit: z.number().int().min(1).max(MAX_COMPACTION_BATCH).optional(),
    /** Scan cap per run — a pass is bounded and resumable (idempotent). */
    maxEventsPerRun: z.number().int().min(1).max(MAX_COMPACTION_MAX_EVENTS).optional(),
    /** How many per-event entries the typed plan carries. */
    planEntryLimit: z.number().int().min(0).max(MAX_COMPACTION_PLAN_ENTRIES).optional(),
  })
  .superRefine((config, ctx) => {
    const summary = config.summaryWindowDays ?? DEFAULT_SUMMARY_WINDOW_DAYS;
    const retention = config.retentionWindowDays ?? DEFAULT_RETENTION_WINDOW_DAYS;
    // A purge fires only after its summary is written: the summary window can never be longer
    // than the retention window, or events would be purged before their digest exists.
    if (retention !== 0 && summary > retention) {
      ctx.addIssue({
        code: 'custom',
        path: ['summaryWindowDays'],
        message:
          `summaryWindowDays (${summary}) must be at most retentionWindowDays (${retention}) — ` +
          'a raw event is purged only after its digest summary exists, so the summary cannot ' +
          'arrive later than the purge (set retentionWindowDays to 0 to keep raw events forever)',
      });
    }
  });
export type EventsCompactionConfigInput = z.input<typeof EventsCompactionConfigSchema>;

/** The resolved configuration — defaults merged over the input (mirrors `resolveConsolidationConfig`). */
export interface EventsCompactionConfig {
  summaryWindowDays: number;
  /** `0` = keep forever (the summarize tier still runs). */
  retentionWindowDays: number;
  batchLimit: number;
  maxEventsPerRun: number;
  planEntryLimit: number;
}

export const DEFAULT_COMPACTION_CONFIG: EventsCompactionConfig = {
  summaryWindowDays: DEFAULT_SUMMARY_WINDOW_DAYS,
  retentionWindowDays: DEFAULT_RETENTION_WINDOW_DAYS,
  batchLimit: DEFAULT_COMPACTION_BATCH,
  maxEventsPerRun: DEFAULT_COMPACTION_MAX_EVENTS,
  planEntryLimit: DEFAULT_COMPACTION_PLAN_ENTRIES,
};

/** Merge a config input over the defaults (Zod-validated at the boundary). */
export function resolveEventsCompactionConfig(
  input?: EventsCompactionConfigInput,
): EventsCompactionConfig {
  const parsed = input === undefined ? {} : EventsCompactionConfigSchema.parse(input);
  return {
    summaryWindowDays: parsed.summaryWindowDays ?? DEFAULT_COMPACTION_CONFIG.summaryWindowDays,
    retentionWindowDays: parsed.retentionWindowDays ?? DEFAULT_COMPACTION_CONFIG.retentionWindowDays,
    batchLimit: parsed.batchLimit ?? DEFAULT_COMPACTION_CONFIG.batchLimit,
    maxEventsPerRun: parsed.maxEventsPerRun ?? DEFAULT_COMPACTION_CONFIG.maxEventsPerRun,
    planEntryLimit: parsed.planEntryLimit ?? DEFAULT_COMPACTION_CONFIG.planEntryLimit,
  };
}

// ---------------------------------------------------------------------------
// Event digests (the `memory_events_digest` rows)
// ---------------------------------------------------------------------------

const isoTimestamp = z.iso.datetime();
const optionalUuid = z.uuid().optional();

/**
 * One digest row — the surviving lineage record of one compacted raw event. The table is
 * deliberately FK-less (like `memory_events`): the digest must outlive the `events` row it
 * summarizes, so nothing may cascade into it.
 */
export const NewEventDigestSchema = z.looseObject({
  id: optionalUuid,
  /** The summarized raw event — the chain `event:<id>` evidence locators resolve against. */
  event_id: z.uuid(),
  kind: z.string().min(1),
  runtime: z.string().min(1),
  adapter_version: z.string().min(1),
  project_id: optionalUuid,
  session_id: z.string().optional(),
  agent_id: z.string().optional(),
  user_id: optionalUuid,
  /** Preserved verbatim — the events dedupe key member survives compaction. */
  content_hash: z.string().min(1),
  occurred_at: isoTimestamp,
  ingested_at: isoTimestamp,
  /** The bounded one-line payload summary (per-kind, extraction's text shapes). */
  summary: z.string().min(1),
  /** Size of the purged raw payload — the audit of what was removed. */
  payload_bytes: z.number().int().min(0),
  /** How many redaction records the raw payload carried (kind + location + length only — ADR-0007). */
  redactions_count: z.number().int().min(0).optional(),
  /** The distinct `sources` rows whose evidence spans anchor this event (the lineage shortcut). */
  source_ids: z.array(z.uuid()).optional(),
});
export type NewEventDigest = z.infer<typeof NewEventDigestSchema>;

/** A digest row read back — a plain output contract (outputs are typed, not re-validated). */
export interface EventDigestRecord {
  id: string;
  event_id: string;
  kind: string;
  runtime: string;
  adapter_version: string;
  project_id: string | null;
  session_id: string | null;
  agent_id: string | null;
  user_id: string | null;
  content_hash: string;
  occurred_at: string;
  ingested_at: string;
  summary: string;
  payload_bytes: number;
  redactions_count: number;
  source_ids: string[];
  created_at: string;
}

// ---------------------------------------------------------------------------
// The EventsCompactor port (storage implements; the only package with SQL)
// ---------------------------------------------------------------------------

/** Keyset position for the scan cursor — `(occurred_at, id)` row comparison, oldest first. */
export interface CompactionCursor {
  occurred_at: string;
  id: string;
}

export interface EventsCompactor {
  /**
   * Raw events older than `olderThan` (ISO), oldest first, bounded by `limit`, advancing past
   * `after` (the keyset cursor — every row is visited at most once per pass).
   */
  listCompactableEvents(options: {
    olderThan: string;
    limit: number;
    scope?: { project_id?: string };
    after?: CompactionCursor;
  }): Promise<StoredEvent[]>;
  /** Which of these event ids already have a digest row (the summarize-once idempotency probe). */
  digestedEventIds(eventIds: readonly string[]): Promise<Set<string>>;
  /**
   * The distinct `sources` rows whose evidence spans (memories + edges, locator `event:<id>`)
   * anchor these events — the denormalized lineage carried on the digest rows.
   */
  sourcesForEvents(eventIds: readonly string[]): Promise<Map<string, string[]>>;
  /**
   * ONE transaction: insert the digest rows (`event_id` unique — conflicts are no-ops), then
   * delete the raw rows. The purge never runs without its summary in the same transaction.
   */
  applyCompaction(batch: {
    digests: NewEventDigest[];
    purgeEventIds: readonly string[];
  }): Promise<{ summarized: number; purged: number }>;
  /** Raw `events` rows matching the scope — the retention ceiling metric. */
  countRawEvents(scope?: { project_id?: string }): Promise<number>;
  /** Digest lookup — the resolver for `event:<id>` evidence locators after compaction. */
  getEventDigest(eventId: string): Promise<EventDigestRecord | null>;
}

// ---------------------------------------------------------------------------
// The typed plan (pure decision — what the pass will do / did)
// ---------------------------------------------------------------------------

export type CompactionAction =
  | 'summarize' // digest written, raw row kept (younger than the retention window)
  | 'summarize_and_purge' // digest written, then the raw row deleted — one pass, one transaction
  | 'purge' // digest already existed; only the raw row is deleted
  | 'keep'; // untouched — young, or blocked (never silently)

/** Why a `keep` happened — always recorded, never silent. */
export type CompactionKeepReason =
  | 'within_summary_window'
  | 'unprocessed'
  | 'needs_review'
  | 'process_error';

export interface CompactionPlanEntry {
  event_id: string;
  kind: string;
  occurred_at: string;
  action: CompactionAction;
  reason: string;
}

export interface EventsCompactionPlan {
  /** Events older than this ISO timestamp get summarized (now − summaryWindowDays). */
  summary_cutoff: string;
  /** Events older than this ISO timestamp get purged; `null` when retention is `0` (keep forever). */
  retention_cutoff: string | null;
  /** Events that still need a digest row (the `summarize` + `summarize_and_purge` actions). */
  to_summarize: number;
  /** Raw rows that would be / were deleted (the `summarize_and_purge` + `purge` actions). */
  to_purge: number;
  /** Events the plan leaves untouched (young, or blocked with a reason). */
  kept: number;
  /** Per-event detail, capped at `planEntryLimit` — counts first, samples second. */
  entries: CompactionPlanEntry[];
  /** The `keep` entries with blocking reasons (`unprocessed` / `needs_review` / `process_error`). */
  blocked: CompactionPlanEntry[];
}

export interface EventsCompactionReport {
  ran_at: string;
  dry_run: boolean;
  scope: { project_id: string | null };
  windows: { summary_window_days: number; retention_window_days: number };
  /** The typed plan — exactly what a dry run prints, and what the executing run followed. */
  plan: EventsCompactionPlan;
  /** Digest rows written (0 in a dry run). */
  summarized: number;
  /** Raw rows deleted (0 in a dry run). */
  purged: number;
  /** Raw `events` rows left in scope after the pass (the retention ceiling metric). */
  raw_events_remaining: number;
  /** Transactions applied (0 in a dry run). */
  batches: number;
  /** Candidates the scan visited. */
  considered: number;
  /** The scan hit `maxEventsPerRun` — older events await the next pass (idempotent resumption). */
  truncated: boolean;
  /** Degradations and blocked-purge explanations — never silent (memory-model.md §1.6). */
  warnings: string[];
}
