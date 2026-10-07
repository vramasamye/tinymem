/**
 * The LLM conflict tier (memory-model.md §9; ADR-0006 §1 "Conflict / contradiction
 * adjudication — reasoning model if configured; authority rules otherwise").
 *
 * WHY this exists: the attribute-template heuristic ({@link contradictsHeuristically}) can only
 * form a candidate when two statements instantiate the SAME attribute template with different
 * scalars ("Version: Node 20" vs "Version: Node 22"). Statements that answer the same question
 * in different words ("PostgreSQL with pgvector as the only database dialect" vs "MySQL for the
 * primary datastore") share no template, so the pair stays silently current — the measured
 * `contradiction_accuracy` miss (M11b finding 1, the M14 follow-up this module closes).
 *
 * The tier is OPT-IN and fail-closed, never load-bearing (AGENTS.md rule 4, local-first):
 * - no `conflict` route on the router → the caller never builds a detector, so the offline
 *   default is byte-identical to the template heuristic;
 * - a provider failure or a schema-invalid verdict CLEARS the pair (a contradiction is never
 *   asserted without evidence) and is recorded, never silent (memory-model.md §1.6);
 * - the arbiter only ADJUDICATES. Scope, validity overlap, and candidate generation stay the
 *   contradiction pass's job, so this seam is pure and independently testable.
 */

import type { MemoryRecord } from '@onememory-ai/core';
import type { ModelRouter } from '@onememory-ai/llm';
import { z } from 'zod';

import { pairKey } from './cluster';
import { contradictsHeuristically, contradictionTemplate, sameScope, temporalOverlap } from './contradiction';

export const CONFLICT_LLM_PROMPT_VERSION = 'consolidation/llm-conflict-1';

/**
 * The memory types eligible for cross-phrasing candidacy: the durable claim types where two rows
 * can answer the SAME question with mutually exclusive answers. Episodic rows are observations
 * (they narrate, they do not decide) and `working` is session scratch — neither carries a claim
 * that a later row can contradict, so scanning them would only buy false candidates.
 */
export const CROSS_PHRASING_TYPES = ['decision', 'semantic', 'preference'] as const;

/** Structured output contract for the router's `conflict` operation. */
export const LlmConflictVerdictSchema = z.looseObject({
  contradicts: z.boolean(),
  reason: z.string().max(200).optional(),
});
export type LlmConflictVerdict = z.infer<typeof LlmConflictVerdictSchema>;

export const CONFLICT_SYSTEM_PROMPT = [
  'You adjudicate whether two memories about the same software project make incompatible claims.',
  'They contradict when they answer the same question with mutually exclusive answers (two different',
  'databases, ports, versions, limits, or choices), even when worded differently. They do NOT',
  'contradict when they are compatible, restate the same answer, or address different questions.',
  'Answer with the JSON object only.',
].join(' ');

/**
 * The adjudication prompt. Ordered by memory id, so the same pair produces the same prompt
 * regardless of the order the pass happens to hand the pair over.
 */
export function buildConflictPrompt(a: MemoryRecord, b: MemoryRecord): string {
  const [first, second] = a.id <= b.id ? [a, b] : [b, a];
  return [
    'Two memories from the same project:',
    `A: ${first.content}`,
    `B: ${second.content}`,
    'Can both be true at the same time? Answer with the JSON object only.',
  ].join('\n');
}

/** Pair → verdict. Async by nature (one model call per pair). */
export type ConflictArbiter = (a: MemoryRecord, b: MemoryRecord) => Promise<boolean>;

export interface LlmConflictDetectorOptions {
  /** Degradation sink — a failed or invalid adjudication is recorded here, never swallowed. */
  warnings?: string[];
}

/**
 * Build the router-backed arbiter. Verdicts are memoized per unordered pair, so a pair the pass
 * considers twice costs one model call, and swapping the arguments cannot change the answer.
 */
export function createLlmConflictDetector(
  router: ModelRouter,
  options: LlmConflictDetectorOptions = {},
): ConflictArbiter {
  const verdicts = new Map<string, boolean>();
  return async (a, b) => {
    const key = pairKey(a.id, b.id);
    const cached = verdicts.get(key);
    if (cached !== undefined) return cached;

    const generation = await router.generateStructured({
      operation: 'conflict',
      schema: LlmConflictVerdictSchema,
      system: CONFLICT_SYSTEM_PROMPT,
      prompt: buildConflictPrompt(a, b),
      schemaName: 'ConflictVerdict',
      schemaDescription: 'Whether two memories make incompatible claims about the same question',
    });

    // Fail-closed: no verdict means no contradiction. The pair is cleared, and the reason is
    // recorded so a degraded adjudication stays visible in the run report.
    const verdict = generation.ok ? generation.value.contradicts : false;
    if (!generation.ok) {
      options.warnings?.push(
        `conflict adjudication failed (${generation.error.kind}: ${generation.error.message})`,
      );
    }
    verdicts.set(key, verdict);
    return verdict;
  };
}

/**
 * The composite conflict definition, and the ONE detector the passes share (the contradiction
 * pass, the merge pass's refusal guard, the derivation cluster check) so they cannot disagree
 * about what a conflict is:
 *
 * 1. different scope or disjoint validity windows → not a conflict, no model call;
 * 2. same attribute template → the deterministic heuristic is authoritative (differing scalars
 *    contradict, equal scalars restate), no model call;
 * 3. different templates → exactly the cross-phrasing case the heuristic cannot decide, so the
 *    reasoning model adjudicates, fail-closed.
 */
export function createConflictDetector(
  router: ModelRouter,
  options: LlmConflictDetectorOptions = {},
): (a: MemoryRecord, b: MemoryRecord) => Promise<boolean> {
  const arbiter = createLlmConflictDetector(router, options);
  return async (a, b) => {
    if (a.id === b.id) return false;
    if (!sameScope(a, b) || !temporalOverlap(a, b)) return false;
    if (contradictionTemplate(a.content) === contradictionTemplate(b.content)) {
      return contradictsHeuristically(a, b);
    }
    return arbiter(a, b);
  };
}
