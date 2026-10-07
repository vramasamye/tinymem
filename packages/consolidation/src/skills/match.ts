/**
 * The failure-signature recurrence matcher (M15 issue 1; ADR-0009 rule 1) — pure, local, and
 * deterministic. This module invents NO clustering: the grouping keys reuse the consolidation
 * passes' own primitives from `../cluster` —
 *
 *   - `scopeKeyOf` — the scope part of every pass's grouping key (no pass groups rows across
 *     scopes), extended with the failure's primary entity and the extraction-stage
 *     `signature_hash` (the stable noise-normalized fingerprint M3b landed — never re-derived
 *     here);
 *   - `pairKey` — the stable unordered pair key every pairwise-gated pass (near-duplicate
 *     merge) keys its certified pairs by, reused for the solution-equivalence certification: a
 *     group qualifies only when EVERY solved pair's solution similarity is ≥ the threshold, and
 *     each certified pair is recorded under its `pairKey` so the report can name exactly the
 *     pair that blocked a group — order-independent, like every other consumer of the helper.
 *
 * The gate (memory-model.md §9, verbatim): "same failure signature solved ≥ 2 times with an
 * equivalent solution AND at least one verification evidence". A group that fails the gate is
 * reported with a typed reason — never silently dropped.
 */

import type { EvidenceSpan, FailureRecurrence, SkillBlockReason } from '@onememory-ai/core';
import {
  MIN_SKILL_FAILURES,
  DEFAULT_SOLUTION_SIMILARITY,
} from '@onememory-ai/core';

import { pairKey, scopeKeyOf } from '../cluster';

/** The scope part of a failure observation — `scopeKeyOf` of the owning memory. */
export type ScopeKey = ReturnType<typeof scopeKeyOf>;

/** The pure projection the matcher (and the document builder) work over. */
export interface FailureObservation {
  memory_id: string;
  scope_key: ScopeKey;
  project_id: string | null;
  /** The owning memory's observed_at — the observation time of the failure. */
  observed_at: string;
  problem: string;
  context: string;
  root_cause: string | null;
  solution: string | null;
  verification: string | null;
  signature_hash: string;
  first_seen_at: string;
  last_seen_at: string;
  /** Entity names in binding order (the primary entity is the first). */
  entities: string[];
  /** The owning memory's evidence spans — the candidate's provenance (AGENTS.md rule 8). */
  evidence: EvidenceSpan[];
}

/** Project a storage `FailureRecurrence` (columns + hydrated memory) to the pure observation. */
export function observationOf(recurrence: FailureRecurrence): FailureObservation {
  return {
    memory_id: recurrence.memory.id,
    scope_key: scopeKeyOf(recurrence.memory),
    project_id: recurrence.memory.project_id ?? null,
    observed_at: recurrence.memory.observed_at,
    problem: recurrence.problem,
    context: recurrence.context,
    root_cause: recurrence.root_cause,
    solution: recurrence.solution,
    verification: recurrence.verification,
    signature_hash: recurrence.signature_hash,
    first_seen_at: recurrence.first_seen_at,
    last_seen_at: recurrence.last_seen_at,
    entities: recurrence.memory.entities.map((entity) => entity.name),
    evidence: recurrence.memory.provenance.evidence,
  };
}

/** One signature group: the same failure, in the same scope, against the same primary entity. */
export interface SignatureGroup {
  /** `${scope_key}|${entity ?? '∅'}|${signature_hash}` — the deterministic grouping key. */
  key: string;
  scope: { project_id: string | null };
  /** The primary entity name (first binding); `null` when the failure is entity-unbound. */
  entity: string | null;
  signature_hash: string;
  /** Every member, ordered by (last_seen_at, memory_id) — deterministic. */
  failures: FailureObservation[];
  /** Members with a solution ("solved" for the gate — the ADR's "solved ≥ 2 times"). */
  solved: FailureObservation[];
  /** Certified solution-similarity per solved pair, keyed by `pairKey(a, b)`. */
  pairSimilarity: Map<string, number>;
  /** True when the group passes the full gate and becomes a skill candidate. */
  qualified: boolean;
  /** Present when the group did not qualify — the typed reason, never silent. */
  reason?: SkillBlockReason;
  /** Human explanation for the gate's decision (names the blocking pair when relevant). */
  detail: string;
}

export interface MatchOptions {
  /** Solved members the gate requires (default 2 — ADR-0009 rule 1's "≥ 2 occurrences"). */
  minFailures?: number;
  /** Pairwise solution-similarity floor (default 0.6, token-set Jaccard). */
  solutionSimilarity?: number;
}

/**
 * The solution-equivalence measure: Jaccard over the normalized token sets (lowercase,
 * alphanumeric runs). Identical text short-circuits to 1. Pure and deterministic — no model
 * calls, no network (AGENTS.md rule 4); the LLM tier stays a future router operation.
 */
export function solutionSimilarityOf(a: string, b: string): number {
  if (a === b) return 1;
  const left = tokenSet(a);
  const right = tokenSet(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

function tokenSet(text: string): Set<string> {
  const set = new Set<string>();
  for (const token of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (token.length > 0) set.add(token);
  }
  return set;
}

/** The primary entity: the first binding in binding order, `null` when unbound. */
export function primaryEntityOf(observation: FailureObservation): string | null {
  return observation.entities[0] ?? null;
}

/**
 * Group the failure pool by (scope, primary entity, signature hash) and apply the generation
 * gate. Groups return in stable first-encounter order of the (deterministically ordered) pool;
 * members are ordered by (last_seen_at, memory_id).
 */
export function groupFailuresBySignature(
  failures: readonly FailureObservation[],
  options: MatchOptions = {},
): SignatureGroup[] {
  const minFailures = options.minFailures ?? MIN_SKILL_FAILURES;
  const similarityFloor = options.solutionSimilarity ?? DEFAULT_SOLUTION_SIMILARITY;

  const byKey = new Map<string, FailureObservation[]>();
  for (const failure of failures) {
    const entity = primaryEntityOf(failure);
    const key = `${failure.scope_key}|${entity ?? '∅'}|${failure.signature_hash}`;
    const members = byKey.get(key);
    if (members) members.push(failure);
    else byKey.set(key, [failure]);
  }

  const groups: SignatureGroup[] = [];
  for (const [key, members] of byKey) {
    const ordered = [...members].sort(
      (a, b) => (a.last_seen_at === b.last_seen_at ? (a.memory_id < b.memory_id ? -1 : 1) : a.last_seen_at < b.last_seen_at ? -1 : 1),
    );
    const solved = ordered.filter((member) => member.solution !== null && member.solution !== '');
    const pairSimilarity = new Map<string, number>();
    for (let i = 0; i < solved.length; i += 1) {
      for (let j = i + 1; j < solved.length; j += 1) {
        const a = solved[i]!;
        const b = solved[j]!;
        pairSimilarity.set(pairKey(a.memory_id, b.memory_id), solutionSimilarityOf(a.solution!, b.solution!));
      }
    }
    const group: SignatureGroup = {
      key,
      scope: { project_id: ordered[0]!.project_id },
      entity: primaryEntityOf(ordered[0]!),
      signature_hash: ordered[0]!.signature_hash,
      failures: ordered,
      solved,
      pairSimilarity,
      qualified: false,
      detail: '',
    };
    gate(group, minFailures, similarityFloor);
    groups.push(group);
  }
  return groups;
}

/** Apply the generation gate in the documented order, recording the typed refusal reason. */
function gate(group: SignatureGroup, minFailures: number, similarityFloor: number): void {
  if (group.solved.length < minFailures) {
    group.reason = 'insufficient_solved_failures';
    group.detail =
      `${group.solved.length} solved failure${group.solved.length === 1 ? '' : 's'} of signature ` +
      `${group.signature_hash} (needs ≥ ${minFailures}: a skill candidate requires the SAME failure ` +
      'solved repeatedly, never one observation — ADR-0009 rule 1)';
    return;
  }
  let weakest: { key: string; score: number } | null = null;
  for (const [key, score] of group.pairSimilarity) {
    if (score < similarityFloor && (weakest === null || score < weakest.score)) weakest = { key, score };
  }
  if (weakest !== null) {
    group.reason = 'divergent_solutions';
    group.detail =
      `solved pair ${weakest.key} has solution similarity ${weakest.score.toFixed(4)} ` +
      `< ${similarityFloor}: the occurrences of signature ${group.signature_hash} were solved ` +
      'different ways — no single procedure to extract yet';
    return;
  }
  if (!group.solved.some((member) => member.verification !== null && member.verification !== '')) {
    group.reason = 'no_verification_evidence';
    group.detail =
      `no solved failure of signature ${group.signature_hash} carries verification evidence ` +
      '(command output digest / test result) — promotion requires proof the fix worked ' +
      '(ADR-0009 rule 2)';
  }
  group.qualified = group.reason === undefined;
  if (group.qualified) {
    group.detail =
      `${group.solved.length} solved occurrences of signature ${group.signature_hash} with ` +
      'pairwise-equivalent solutions and verification evidence';
  }
}
