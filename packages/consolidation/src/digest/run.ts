/**
 * The project digest pass (backlog M14.5) — the callable stages over the real reads and the
 * audited Store paths:
 *
 * - {@link runProjectDigest}: read-only. Pulls the project's top accepted decisions, known
 *   failures, and current procedures through the SAME search-repo shortcuts the
 *   `memory_project_context` tool surface uses (`latestAcceptedDecisions`, `recentFailures`,
 *   `listCurrentMemories`) and folds them into ONE typed, token-bounded digest candidate
 *   (`kind: 'project_context'`, `used ≤ budget` by construction). No writes — the pure builder
 *   ({@link ./rollup}) owns the assembly.
 * - {@link runDigest}: the persisting pass. Writes ONE `semantic` / `project_context` memory row
 *   per project per invocation — created the first time, supersession-managed through the Store's
 *   audited transaction when the rollup changed, `unchanged` when the content hash did not — and
 *   merges the renderable entries into `projects.digest` (the column the existing MCP
 *   `memory_project_context` tool renders, so the rollup surfaces with ZERO changes to the tool
 *   surface).
 *
 * Idempotency mirrors the M4f architecture digest exactly: the unchanged case is probed through
 * the Store's exact-dedupe lookup (windowless, any age); only a CHANGED digest's predecessor is
 * located by a windowed scan (the Store port exposes no tag/subtype filter — the same windowing
 * policy the M4f report documents as a core/storage follow-up).
 *
 * Zero network, zero model calls — the rollup is deterministic text over durable rows
 * (AGENTS.md rules 4 and 7).
 */

import {
  type MemoryRecord,
  type ProjectDigestCandidate,
  type Store,
} from '@onememory-ai/core';
import { digestRepo, searchRepo, type Database } from '@onememory-ai/storage';

import { errorMessage } from '../util';
import { buildProjectDigest, digestMemoryOf, type ProjectDigestBuildInput } from './rollup';

/** The audit actor for every digest mutation (the consolidation job's own vocabulary). */
export const PROJECT_DIGEST_ACTOR = 'job:consolidate';

/** The supersede reason stamped on a refreshed digest's audit rows. */
export const PROJECT_DIGEST_SUPERSEDE_REASON = 'project_digest_refresh';

/** Per-section read caps — retrieval.md §2's "top N" for each digest section. */
export const DEFAULT_PROJECT_DIGEST_COUNTS = { decisions: 8, failures: 6, procedures: 6 } as const;

// ---------------------------------------------------------------------------
// The current-digest locator (the M4f architecture digest's predicate, project_context edition)
// ---------------------------------------------------------------------------

/** Structural shape of a memory row the locator predicate reads (no store import). */
export interface ProjectDigestLikeMemory {
  subtype?: string | null;
  tags: readonly string[];
  status: string;
  valid_until?: string | null;
}

/**
 * The deterministic digest locator: this row IS the project's current context digest (the stable
 * `project_context` subtype + `project_digest` tag, still current — `queryCurrent` semantics:
 * status active/stale and no `valid_until`).
 */
export function isCurrentProjectDigest(memory: ProjectDigestLikeMemory | null): boolean {
  return (
    memory !== null &&
    memory.subtype === 'project_context' &&
    memory.tags.includes('project_digest') &&
    (memory.status === 'active' || memory.status === 'stale') &&
    (memory.valid_until === null || memory.valid_until === undefined)
  );
}

/** A winner's `observed_at` must be strictly after the loser's `valid_from` (the Store's supersede rule). */
function supersedingObservedAt(now: string, loser: MemoryRecord): string {
  const candidate = Date.parse(now);
  const floor = Date.parse(loser.valid_from) + 1;
  return new Date(Math.max(candidate, floor)).toISOString();
}

// ---------------------------------------------------------------------------
// runProjectDigest — the read-only candidate builder (the library's pure entry)
// ---------------------------------------------------------------------------

export interface ProjectDigestInput {
  /** The project's read handle (structural: every Store satisfies it). */
  store: Pick<Store, 'getProject'>;
  /** The SQL client the search-repo shortcuts read through (the `memory_project_context` reads). */
  client: Database;
  project_id: string;
  budget?: number;
  /** Per-section read caps (defaults: 8 decisions / 6 failures / 6 procedures). */
  counts?: Partial<{ decisions: number; failures: number; procedures: number }>;
  now?: () => Date;
}

/** What `runProjectDigest` needs, resolved. */
interface ResolvedDigestReads {
  projectId: string;
  projectName: string | null;
  description: string | null;
  decisions: ProjectDigestBuildInput['decisions'];
  failures: ProjectDigestBuildInput['failures'];
  procedures: ProjectDigestBuildInput['procedures'];
}

/**
 * The read+build pass — deterministic given storage state and the clock, and side-effect-free:
 * it never writes. Returns null when the project does not exist (an honest nothing-to-digest,
 * the caller reports it). An existing project with no digest sources yields a header-only
 * candidate (the caller decides whether that is worth persisting).
 */
export async function runProjectDigest(input: ProjectDigestInput): Promise<ProjectDigestCandidate | null> {
  const now = input.now ?? (() => new Date());
  const counts = { ...DEFAULT_PROJECT_DIGEST_COUNTS, ...input.counts };
  const project = await input.store.getProject(input.project_id);
  if (project === null) return null;

  // The SAME reads the session-context assembly runs (retrieval.md §2): the digest and the
  // `memory_project_context` tool can never disagree about what "top decisions / known
  // failures / current procedures" means.
  const nowIso = now().toISOString();
  const filter: searchRepo.CandidateFilter = {
    statuses: ['active', 'stale'],
    window: { kind: 'point', at: nowIso },
    projectId: input.project_id,
  };
  const reads: ResolvedDigestReads = {
    projectId: input.project_id,
    projectName: project.name,
    description: project.description,
    decisions: await searchRepo.latestAcceptedDecisions(input.client, { limit: counts.decisions }, filter),
    failures: await searchRepo.recentFailures(input.client, { limit: counts.failures }, filter),
    procedures: await searchRepo.listCurrentMemories(
      input.client,
      { types: ['procedural'], limit: counts.procedures, order: 'importance' },
      filter,
    ),
  };

  return buildProjectDigest({
    project_id: reads.projectId,
    project_name: reads.projectName,
    description: reads.description,
    decisions: reads.decisions,
    failures: reads.failures,
    procedures: reads.procedures,
    ...(input.budget === undefined ? {} : { budget: input.budget }),
    now_iso: nowIso,
  });
}

// ---------------------------------------------------------------------------
// runDigest — the persisting pass
// ---------------------------------------------------------------------------

export interface ProjectDigestPassInput extends ProjectDigestInput {
  /** The write handles the pass needs (structural: every Store satisfies it). */
  store: Pick<
    Store,
    'getProject' | 'findDuplicate' | 'queryCurrent' | 'createSource' | 'insertMemory' | 'supersede' | 'addEdge'
  >;
  actor?: string;
}

export interface ProjectDigestPassResult {
  ran_at: string;
  actor: string;
  project_id: string;
  outcome: 'created' | 'refreshed' | 'unchanged' | 'skipped' | 'failed';
  memory_id: string | null;
  /** The candidate this pass built (null only for the unknown-project skip/failure paths). */
  digest: ProjectDigestCandidate | null;
  warnings: string[];
}

/**
 * Run the digest pass for ONE project: build the candidate, persist it (create / audited
 * supersede / unchanged), link `derived_from` edges to every cited source, and merge the
 * renderable entries into `projects.digest`. Never throws — degradation is an explicit warning
 * and an honest `failed`/`skipped` outcome.
 */
export async function runDigest(input: ProjectDigestPassInput): Promise<ProjectDigestPassResult> {
  const now = input.now ?? (() => new Date());
  const actor = input.actor ?? PROJECT_DIGEST_ACTOR;
  const base = { ran_at: now().toISOString(), actor, project_id: input.project_id };
  const warnings: string[] = [];

  try {
    const candidate = await runProjectDigest(input);
    if (candidate === null) {
      return {
        ...base,
        outcome: 'skipped',
        memory_id: null,
        digest: null,
        warnings: [`project ${input.project_id} not found — nothing to digest`],
      };
    }
    const readSources = candidate.sources.decisions + candidate.sources.failures + candidate.sources.procedures;
    if (readSources === 0) {
      return {
        ...base,
        outcome: 'skipped',
        memory_id: null,
        digest: candidate,
        warnings: [
          'no decisions, failures, or procedures to roll up yet — the digest is built once the pipeline stores durable memories',
        ],
      };
    }

    // 1. The unchanged probe — the Store's exact-dedupe lookup (windowless, any age): a digest
    //    whose text did not change is NEVER re-written.
    const identical = await input.store.findDuplicate(
      { project_id: input.project_id },
      'semantic',
      candidate.content_hash,
    );
    if (identical !== null && isCurrentProjectDigest(identical)) {
      await healAround(input, identical.id, candidate, warnings);
      return { ...base, outcome: 'unchanged', memory_id: identical.id, digest: candidate, warnings };
    }

    // 2. The changed (or first) digest: locate the current predecessor for supersession. The
    //    Store port has no tag/subtype-filtered query, so this lookup is bounded by the port's own
    //    limit (1000, its maximum) — the same windowing policy the M4f architecture digest uses.
    //    Re-runs keep the digest recent, so the window cannot miss in practice; the deterministic
    //    filter is a documented core/storage follow-up (see the mission report).
    const previous = (
      await input.store.queryCurrent({ project_id: input.project_id, types: ['semantic'], limit: 1000 })
    ).find(isCurrentProjectDigest);

    // 3. Provenance anchor: reuse the previous digest's source row (M4f semantics) or mint one.
    const sourceId =
      previous !== undefined
        ? previous.provenance.source.id
        : (
            await input.store.createSource({
              kind: 'api',
              uri: `onemem://project-digest/${input.project_id}`,
              title: 'project context digest',
              project_id: input.project_id,
            })
          ).id;
    const observedAt =
      previous !== undefined ? supersedingObservedAt(now().toISOString(), previous) : candidate.observed_at;
    const winner = digestMemoryOf(candidate, { source_id: sourceId, observed_at: observedAt });

    // 4. Persist — the first digest inserts, a changed one supersedes through the audited
    //    transaction (loser status/valid_until/superseded_by + winner insert + audit rows).
    let memoryId: string;
    let outcome: ProjectDigestPassResult['outcome'];
    if (previous === undefined) {
      const written = await input.store.insertMemory(winner);
      if (written.outcome === 'duplicate') {
        // The exact text matches an existing semantic row (the dedupe index spans superseded
        // rows): honest warning, never a fresh 'created' — the M4f digest's identical handling.
        const existing = written.existing ?? written.memory;
        if (!isCurrentProjectDigest(existing)) {
          warnings.push(
            'project digest text matches a superseded historical digest; the storage dedupe index blocks re-inserting it (no current digest row was written)',
          );
        }
        await healAround(input, existing.id, candidate, warnings);
        return { ...base, outcome: 'unchanged', memory_id: existing.id, digest: candidate, warnings };
      }
      memoryId = written.memory.id;
      outcome = 'created';
    } else {
      const superseded = await input.store.supersede({
        winner,
        loser_id: previous.id,
        actor,
        reason: PROJECT_DIGEST_SUPERSEDE_REASON,
      });
      memoryId = superseded.winner.id;
      outcome = superseded.outcome === 'winner-duplicate' ? 'unchanged' : 'refreshed';
      if (superseded.outcome === 'winner-duplicate') {
        // The new text matches a SUPERSEDED historical digest (the dedupe index spans superseded
        // rows): nothing current was written and the current digest row stays as-is — the same
        // honest warning the insert-duplicate path gives, never a silent 'unchanged'.
        warnings.push(
          'project digest text matches a superseded historical digest; the storage dedupe index blocks re-inserting it (the current digest row stays as-is)',
        );
      }
    }

    // 5. The graph + the renderable projection. Both are idempotent and self-healing — a failure
    //    here is a warning, never a lost digest: the durable memory stands, the next run repairs.
    await healAround(input, memoryId, candidate, warnings);
    return { ...base, outcome, memory_id: memoryId, digest: candidate, warnings };
  } catch (error) {
    return {
      ...base,
      outcome: 'failed',
      memory_id: null,
      digest: null,
      warnings: [`project digest pass failed: ${errorMessage(error)}`],
    };
  }
}

/**
 * The idempotent, self-healing writes around the digest row: `derived_from` edges to every cited
 * source (a crashed earlier run's missing edges are completed) and the `projects.digest` merge
 * (the renderable record the `memory_project_context` tool reads). Failures are warnings.
 */
async function healAround(
  input: ProjectDigestPassInput,
  memoryId: string,
  candidate: ProjectDigestCandidate,
  warnings: string[],
): Promise<void> {
  for (const sourceId of candidate.source_ids) {
    try {
      await input.store.addEdge({
        from_memory_id: memoryId,
        to_memory_id: sourceId,
        relation: 'derived_from',
        project_id: input.project_id,
      });
    } catch (error) {
      warnings.push(`derived_from edge to ${sourceId} failed: ${errorMessage(error)}`);
    }
  }
  try {
    const updated = await digestRepo.updateProjectDigest(input.client, input.project_id, candidate.entries);
    if (updated === null) warnings.push(`projects.digest update missed: project ${input.project_id} disappeared mid-pass`);
  } catch (error) {
    warnings.push(`projects.digest update failed: ${errorMessage(error)}`);
  }
}
