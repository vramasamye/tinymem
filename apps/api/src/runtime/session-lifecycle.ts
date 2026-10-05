/**
 * The session-end working-memory lifecycle (memory-model.md §10; phased-plan.md Phase 2 DoD:
 * "session end sweeps working memory with promotion filter"; parity memo §5 Tier A item 1).
 *
 * When ingest observes a `session.end` event for a session, one pass runs for that session:
 *
 * 1. **Record the end** — the `sessions` row is upserted with `ended_at` (and the end summary
 *    when the event carried one) through `Store.createSession`, the existing upsert.
 * 2. **Promotion** — working rows that pass the deterministic filter (`promotionDecision`) become
 *    durable `episodic` memories through `Store.insertMemory`, the audited create path (the
 *    repository writes the `created` audit row in the same transaction): source and evidence are
 *    carried verbatim from the working row, never re-derived or invented (AGENTS.md rule 8 - a
 *    working row without provenance is never promoted). Each promoted row is then marked via
 *    `Store.markWorkingPromoted`.
 * 3. **Sweep** — expired unpromoted rows are purged via `Store.sweepWorking`; promoted rows
 *    survive by the purge predicate (`promoted_memory_id IS NULL`).
 *
 * Why `episodic` for every working kind: a working row is a single session observation. Semantic
 * memories are never created from single observations (ADR-0003 rule 7), and a decision candidate
 * without alternatives + rationale "remains an episodic note" (memory-model.md §9) - so `task`,
 * `hypothesis`, `current_file`, `current_error`, `temp_decision` and `open_question` all promote
 * as episodic notes carrying their session provenance.
 *
 * Idempotency: the pass may run any number of times for the same session end (ingest deliberately
 * re-runs it on a duplicate end event, healing a crash between "event stored" and "pass ran").
 * Already-promoted rows are skipped by the filter, `insertMemory` collapses exact content
 * duplicates onto the existing memory (the row is then linked to that memory), and the sweep never
 * touches promoted rows - so re-running can only be a no-op.
 *
 * The pass runs inline in the ingest path rather than as a job: the job-queue vocabulary
 * (`JOB_KINDS` in `@onememory/core`) has no session-sweep kind, the pass is DB-only (no model, no
 * network - local-first invariant holds), and it is bounded by the session's working rows.
 */

import {
  estimateTokens,
  type EvidenceSpan,
  type SessionRecord,
  type WorkingMemoryRecord,
} from '@onememory/core';

import type { OnememoryRuntime } from './composition';

/**
 * The documented session-end promotion threshold: memory-model.md §10 specifies "importance
 * ≥ 0.5 OR explicitly flagged by user/agent". Working rows carry no explicit-flag field, so the
 * flag arm stays future work; the threshold arm is the deterministic rule this pass enforces.
 */
export const PROMOTION_IMPORTANCE_THRESHOLD = 0.5;

/**
 * The extraction label for promoted rows. Promotions run no model (the `EXPLICIT_PROMPT_VERSION`
 * precedent in memory-service: the label says what ran instead of pretending extraction happened).
 */
export const SESSION_SWEEP_PROMPT_VERSION = 'session-sweep-v1';

/** Why a working row was not promoted - the closed skip-reason vocabulary. */
export type PromotionSkipReason =
  | 'already_promoted'
  | 'no_source'
  | 'no_evidence'
  | 'below_importance_threshold';

export type PromotionDecision =
  | { eligible: false; reason: PromotionSkipReason }
  | { eligible: true; source_id: string; evidence: EvidenceSpan[] };

/**
 * The deterministic promotion filter. A working row becomes a durable memory iff:
 *
 * 1. it was not promoted yet (idempotency guard),
 * 2. it carries its own source anchor (`source_id`) - a durable memory's `source_id` is required,
 *    and the pass never invents one from elsewhere,
 * 3. it carries at least one evidence span (the durable provenance invariant, ADR-0003 rule 4,
 *    checked here rather than letting `insertMemory` throw),
 * 4. its importance is at or above {@link PROMOTION_IMPORTANCE_THRESHOLD}.
 *
 * Rows that fail stay in working memory until their TTL; the sweep purges them once expired.
 */
export function promotionDecision(row: WorkingMemoryRecord): PromotionDecision {
  if (row.promoted_memory_id !== null) return { eligible: false, reason: 'already_promoted' };
  if (row.source_id === null) return { eligible: false, reason: 'no_source' };
  if (row.evidence.length === 0) return { eligible: false, reason: 'no_evidence' };
  if (row.importance < PROMOTION_IMPORTANCE_THRESHOLD) {
    return { eligible: false, reason: 'below_importance_threshold' };
  }
  return { eligible: true, source_id: row.source_id, evidence: row.evidence };
}

/** What ingest observed about one session end (the `session.end` envelope, distilled). */
export interface SessionEndObservation {
  session_id: string;
  /** The runtime that reported the end (envelope `source.runtime`); anchors the sessions row. */
  runtime: string;
  /** Payload `ended_at`, falling back to the envelope `occurred_at`. */
  ended_at: string;
  /** Payload `started_at`, when the end event carried it. */
  started_at?: string;
  /** Payload `summary`, when the end event carried one. */
  summary?: string;
}

export interface SessionEndLifecycleResult {
  session_id: string;
  /** The upserted sessions row - `createSession` returns the row it wrote. */
  session: SessionRecord;
  /** Working rows the pass examined. */
  considered: number;
  /** Rows linked to a durable memory this pass (inserted + linked_existing). */
  promoted: number;
  /** Rows that became a NEW durable memory. */
  inserted: number;
  /** Rows whose exact content already existed durably and were linked onto that memory. */
  linked_existing: number;
  /** Per-reason counts of rows the filter rejected (they stay in working memory). */
  skipped: Record<PromotionSkipReason, number>;
  /** Sum of {@link skipped}, computed by the pass so callers cannot undercount by omission. */
  skipped_total: number;
  /** Promotion writes that threw (defensive: rows written by writers that bypass `insertWorking`
   * validation, or concurrent purges). Recorded per row, never fatal for the pass. */
  failed: number;
  /** Bounded error messages for the failed rows. */
  failures: string[];
  /** Expired unpromoted rows purged by the sweep (global - `sweepWorking` has no session filter). */
  expired_purged: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run the session-end lifecycle pass for one observed session end. Throws only on structural
 * failures (session upsert, working-list read, sweep); per-row promotion failures are recorded
 * in the result so one bad row cannot block the rest of the session's promotions.
 */
export async function runSessionEndLifecycle(
  runtime: OnememoryRuntime,
  projectId: string,
  observation: SessionEndObservation,
): Promise<SessionEndLifecycleResult> {
  const store = runtime.storage.store;

  // 1. Record the end. `started_at` is required by the schema even on the conflict path (where the
  //    upsert leaves the existing start untouched), so it falls back to the end time.
  const session = await store.createSession({
    id: observation.session_id,
    project_id: projectId,
    runtime: observation.runtime,
    started_at: observation.started_at ?? observation.ended_at,
    ended_at: observation.ended_at,
    ...(observation.summary === undefined ? {} : { summary: observation.summary }),
  });

  // 2. Promote what passes the filter, through the audited create path.
  const rows = await store.listWorking(observation.session_id);
  const skipped: Record<PromotionSkipReason, number> = {
    already_promoted: 0,
    no_source: 0,
    no_evidence: 0,
    below_importance_threshold: 0,
  };
  let inserted = 0;
  let linkedExisting = 0;
  const failures: string[] = [];

  for (const row of rows) {
    const decision = promotionDecision(row);
    if (!decision.eligible) {
      skipped[decision.reason] += 1;
      continue;
    }

    try {
      // Provenance carried verbatim: the row's own source and evidence spans, its scores, and its
      // created_at as the observation time. Scope is the ingest project (endpoint-authoritative).
      const write = await store.insertMemory({
        type: 'episodic',
        content: row.content,
        importance: row.importance,
        confidence: row.confidence,
        observed_at: row.created_at,
        valid_from: row.created_at,
        project_id: projectId,
        source_id: decision.source_id,
        evidence: decision.evidence,
        extraction: {
          method: 'heuristic',
          prompt_version: SESSION_SWEEP_PROMPT_VERSION,
          adapter: 'session-lifecycle',
          session_id: row.session_id,
        },
        tags: ['promoted', `working:${row.kind}`],
        token_estimate: estimateTokens(row.content),
      });
      // On `duplicate` the memory field holds the existing row, so both outcomes link correctly.
      await store.markWorkingPromoted(row.id, write.memory.id);
      if (write.outcome === 'inserted') inserted += 1;
      else linkedExisting += 1;
    } catch (error) {
      failures.push(errorMessage(error).slice(0, 200));
    }
  }

  // 3. Sweep: purge expired unpromoted rows (promoted rows survive the predicate by design).
  const sweep = await store.sweepWorking();
  const skippedTotal = Object.values(skipped).reduce((total, count) => total + count, 0);

  if (inserted > 0) {
    // retrieval.md §5: a durable write invalidates the result cache.
    runtime.engine.invalidateCache(projectId);
  }

  return {
    session_id: observation.session_id,
    session,
    considered: rows.length,
    promoted: inserted + linkedExisting,
    inserted,
    linked_existing: linkedExisting,
    skipped,
    skipped_total: skippedTotal,
    failed: failures.length,
    failures,
    expired_purged: sweep.purged,
  };
}
