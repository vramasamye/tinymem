/**
 * Skill types — the M15 skill-generation contract (backlog §M15; ADR-0009; memory-model.md §9
 * "Failure → skill candidate"; event-memory-schemas.md §5 `SkillPayload` + the SKILL.md layout).
 *
 * The lifecycle this file pins (ADR-0009 rule 4):
 *
 *   candidate ──(onemem skills promote: user confirmation + verification evidence)──▶ verified
 *   verified ──(usage proves the skill)──▶ promoted ──▶ deprecated   (explicit, never silent)
 *   candidate / verified ──▶ deprecated
 *
 * A candidate is generated ONLY from a recurring failure signature (same project + entity,
 * ≥ 2 solved occurrences with pairwise-equivalent solutions, ≥ 1 verification evidence) — never
 * from a single observation, and NEVER auto-promoted (`auto_promote_skills = false` by default:
 * the promotion gate is the `onemem skills review` / `promote` flow, a human in the loop).
 *
 * Who codes against what (repository-structure.md, the EventsCompactor precedent): core declares
 * this file; storage implements the `SkillStore` port (the only package with SQL) over the
 * M2-landed `skills` table (no schema change rides on M15); consolidation orchestrates the pass
 * (`runSkillGeneration` — packages/consolidation/src/skills); the CLI drives the review flow;
 * the MCP `memory_skills` tool serves the verified list (ADR-0010 §2, the 11-tool full surface).
 *
 * Provenance (AGENTS.md rule 8): every skill state change appends to the SAME append-only
 * `memory_events` audit trail as every memory transition — `memory_id` carries the skill's id
 * (the table is FK-less by design so audit rows outlive their subject), the skill-status
 * transition rides `details` because `from_status`/`to_status` are memory-status enums.
 */

import { z } from 'zod';

import { SKILL_STATUSES, type SkillStatus } from '../model/types';
import { EvidenceSpanSchema, type EvidenceSpan } from '../schema/extraction';
import { SkillPayloadSchema, type MemoryRecord } from '../schema/memory';

const isoTimestamp = z.iso.datetime();
const optionalUuid = z.uuid().optional();

// ---------------------------------------------------------------------------
// Defaults + the canonical SKILL.md section contract
// ---------------------------------------------------------------------------

/** The generation gate: a candidate needs ≥ this many solved failures of one signature (AC1). */
export const MIN_SKILL_FAILURES = 2;

/** The default solution-equivalence floor for pairwise solution comparison (ADR-0009 rule 1). */
export const DEFAULT_SOLUTION_SIMILARITY = 0.6;

/** Failure rows the generation pool scans per run — the pass is bounded, safe to schedule. */
export const DEFAULT_SKILL_POOL_LIMIT = 500;
export const MAX_SKILL_POOL_LIMIT = 5000;

/** Solved failures carried as candidate evidence (`source.failure_ids`, capped, newest kept). */
export const MAX_SKILL_EVIDENCE_FAILURES = 5;

/** The description bound — one line, the same budget as `content_summary`. */
export const MAX_SKILL_DESCRIPTION_CHARS = 160;

/** The `memory_skills` tool's default token budget (ADR-0010 §3; the AC's 500). */
export const DEFAULT_SKILL_SERVE_TOKENS = 500;

/**
 * The canonical SKILL.md sections, in order — the layout every generated skill renders
 * (memory-model.md §9; the evaluator grades against exactly this list). The renderer MUST emit
 * every section, in this order, so a missing section is a rendering bug, not an empty skill.
 */
export const SKILL_MD_SECTIONS = [
  'When to use',
  'Prerequisites',
  'Procedure',
  'Commands',
  'Validation',
  'Known failure modes',
] as const;
export type SkillMdSection = (typeof SKILL_MD_SECTIONS)[number];

// ---------------------------------------------------------------------------
// Configuration (Zod at the boundary — the library entry and the CLI both pass through here)
// ---------------------------------------------------------------------------

export const SkillGenerationConfigSchema = z.looseObject({
  /** Failure rows scanned per run (bounded; truncated runs are reported, never silent). */
  poolLimit: z.number().int().min(10).max(MAX_SKILL_POOL_LIMIT).optional(),
  /** Solved failures of one signature the gate requires (floor 2 — ADR-0009 rule 1). */
  minFailures: z.number().int().min(MIN_SKILL_FAILURES).max(50).optional(),
  /** Pairwise solution-similarity floor (token-set Jaccard; identical text short-circuits to 1). */
  solutionSimilarity: z.number().min(0).max(1).optional(),
  /** Solved failures carried as candidate evidence (newest kept). */
  maxEvidenceFailures: z.number().int().min(MIN_SKILL_FAILURES).max(20).optional(),
});
export type SkillGenerationConfigInput = z.input<typeof SkillGenerationConfigSchema>;

export interface SkillGenerationConfig {
  poolLimit: number;
  minFailures: number;
  solutionSimilarity: number;
  maxEvidenceFailures: number;
}

export const DEFAULT_SKILL_GENERATION_CONFIG: SkillGenerationConfig = {
  poolLimit: DEFAULT_SKILL_POOL_LIMIT,
  minFailures: MIN_SKILL_FAILURES,
  solutionSimilarity: DEFAULT_SOLUTION_SIMILARITY,
  maxEvidenceFailures: MAX_SKILL_EVIDENCE_FAILURES,
};

/** Merge a config input over the defaults (Zod-validated at the boundary). */
export function resolveSkillGenerationConfig(
  input?: SkillGenerationConfigInput,
): SkillGenerationConfig {
  const parsed = input === undefined ? {} : SkillGenerationConfigSchema.parse(input);
  return {
    poolLimit: parsed.poolLimit ?? DEFAULT_SKILL_GENERATION_CONFIG.poolLimit,
    minFailures: parsed.minFailures ?? DEFAULT_SKILL_GENERATION_CONFIG.minFailures,
    solutionSimilarity: parsed.solutionSimilarity ?? DEFAULT_SKILL_GENERATION_CONFIG.solutionSimilarity,
    maxEvidenceFailures: parsed.maxEvidenceFailures ?? DEFAULT_SKILL_GENERATION_CONFIG.maxEvidenceFailures,
  };
}

// ---------------------------------------------------------------------------
// Skill lifecycle transitions (the candidate → verified → promoted → deprecated machine)
// ---------------------------------------------------------------------------

/** The legal skill-status edges: the promotion gate, usage promotion, explicit deprecation. */
const SKILL_TRANSITIONS: Readonly<Record<SkillStatus, readonly SkillStatus[]>> = {
  candidate: ['verified', 'deprecated'],
  verified: ['promoted', 'deprecated'],
  promoted: ['deprecated'],
  deprecated: [],
};

/** May a skill move `from` → `to`? (Pure — the storage port calls this before every UPDATE.) */
export function canTransitionSkill(from: SkillStatus, to: SkillStatus): boolean {
  return SKILL_TRANSITIONS[from].includes(to);
}

export class InvalidSkillTransitionError extends Error {
  constructor(
    public readonly from: SkillStatus,
    public readonly to: SkillStatus,
  ) {
    super(`invalid skill status transition ${from} → ${to}`);
    this.name = 'InvalidSkillTransitionError';
  }
}

/** Throw on an illegal edge (the message names both ends, like the memory status machine). */
export function assertSkillTransition(from: SkillStatus, to: SkillStatus): void {
  if (!canTransitionSkill(from, to)) throw new InvalidSkillTransitionError(from, to);
}

// ---------------------------------------------------------------------------
// The wire records (the `skills` table row; ADR-0009 rule 4 fields)
// ---------------------------------------------------------------------------

/** A `skills` row read back — the wire `SkillPayload` plus the row's own identity + timestamps. */
export const SkillRecordSchema = z.looseObject({
  ...SkillPayloadSchema.shape,
  id: z.uuid(),
  project_id: optionalUuid,
  created_at: isoTimestamp,
  updated_at: isoTimestamp,
});
export type SkillRecord = z.infer<typeof SkillRecordSchema>;

/** A candidate the generation pass inserts — `status` defaults to `candidate`, never promoted. */
export const NewSkillSchema = z.looseObject({
  id: optionalUuid,
  project_id: optionalUuid,
  name: SkillPayloadSchema.shape.name,
  description: SkillPayloadSchema.shape.description,
  /** Semver, default `1.0.0`. */
  version: SkillPayloadSchema.shape.version.optional(),
  /** Default `candidate` (ADR-0009 rule 2: generation never promotes). */
  status: z.enum(SKILL_STATUSES).optional(),
  source: SkillPayloadSchema.shape.source,
  verification: SkillPayloadSchema.shape.verification,
  path: SkillPayloadSchema.shape.path,
  usage_count: z.number().int().min(0).optional(),
  success_rate: z.number().min(0).max(1).optional(),
});
export type NewSkill = z.input<typeof NewSkillSchema>;

/**
 * The failure view the recurrence matcher consumes — a `failures` row joined to its memory
 * (entity bindings hydrated), with every payload column the generation gate reads. This is the
 * storage read model, not a new wire schema: the payload fields mirror `FailurePayloadSchema`.
 */
export interface FailureRecurrence {
  /** The owning memory (evidence spans, entity bindings, scope, temporals — provenance). */
  memory: MemoryRecord;
  problem: string;
  context: string;
  root_cause: string | null;
  solution: string | null;
  verification: string | null;
  failure_status: string;
  /** The recurrence fingerprint the extraction stage computed (ADR-0009 rule 1). */
  signature_hash: string;
  first_seen_at: string;
  last_seen_at: string;
  occurrence_count: number;
}

/** Why a signature group did NOT become a candidate — always recorded, never silent. */
export const SKILL_BLOCK_REASONS = [
  'insufficient_solved_failures',
  'divergent_solutions',
  'no_verification_evidence',
] as const;
export type SkillBlockReason = (typeof SKILL_BLOCK_REASONS)[number];

/** One blocked signature group in the report (counts first, capped samples second). */
export interface SkillBlockedGroup {
  signature_hash: string;
  entity: string | null;
  scope: { project_id: string | null };
  reason: SkillBlockReason;
  /** Human-readable explanation (names the failing pair for `divergent_solutions`). */
  detail: string;
  failures: number;
}

/** One qualified signature group that became (or refreshed) a candidate. */
export interface SkillCandidateRecord {
  skill_id: string;
  name: string;
  path: string;
  /** `created` (first generation), `refreshed` (new failures joined an existing candidate), `unchanged`. */
  outcome: 'created' | 'refreshed' | 'unchanged';
  signature_hash: string;
  entity: string | null;
  failure_ids: string[];
  /** The canonical SKILL.md bytes — the same bytes `review` prints and `promote` writes. */
  markdown: string;
}

export interface SkillGenerationReport {
  ran_at: string;
  actor: string;
  scope: { project_id: string | null };
  /** The failure pool the pass scanned (truncated: the read cap was reached). */
  pool: { failures: number; truncated: boolean };
  /** Signature groups considered (same project + entity + signature). */
  groups: { considered: number; qualified: number; blocked: number };
  candidates: {
    created: number;
    refreshed: number;
    unchanged: number;
    records: SkillCandidateRecord[];
  };
  /** Capped blocked-group samples — the counts stay exact, the samples explain them. */
  blocked: SkillBlockedGroup[];
  /** Degradations and gate refusals — never silent (memory-model.md §1.6). */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Freshness / decay (M15 follow-up 2)
// ---------------------------------------------------------------------------

/**
 * ADR-0009 rule 4: the lifecycle is `candidate → verified → promoted → deprecated`, and
 * deprecation "mirrors Memp's explicit deprecation rather than silent removal". A verified skill
 * whose underlying failure signature stops recurring is therefore a CANDIDATE FOR DEPRECATION —
 * this pass only reports it; the flip to `deprecated` is the operator's (`onemem skills
 * deprecate`), audited like every other transition.
 *
 * (`verified → candidate` is deliberately not a legal edge — a served artifact never silently
 * reverts to the review queue. Decay is reported, and retiring is explicit.)
 */
export const SkillFreshnessConfigSchema = z.looseObject({
  /** Recent failures scanned per pass (bounded; truncated runs are reported, never silent). */
  poolLimit: z.number().int().min(10).max(MAX_SKILL_POOL_LIMIT).optional(),
  /** Skills assessed per pass (bounded, newest-updated first). */
  skillLimit: z.number().int().min(1).max(1000).optional(),
});
export type SkillFreshnessConfigInput = z.input<typeof SkillFreshnessConfigSchema>;

export interface SkillFreshnessConfig {
  poolLimit: number;
  skillLimit: number;
}

export const DEFAULT_SKILL_FRESHNESS_CONFIG: SkillFreshnessConfig = {
  poolLimit: DEFAULT_SKILL_POOL_LIMIT,
  skillLimit: 200,
};

/** Merge a config input over the defaults (Zod-validated at the boundary). */
export function resolveSkillFreshnessConfig(
  input?: SkillFreshnessConfigInput,
): SkillFreshnessConfig {
  const parsed = input === undefined ? {} : SkillFreshnessConfigSchema.parse(input);
  return {
    poolLimit: parsed.poolLimit ?? DEFAULT_SKILL_FRESHNESS_CONFIG.poolLimit,
    skillLimit: parsed.skillLimit ?? DEFAULT_SKILL_FRESHNESS_CONFIG.skillLimit,
  };
}

/** One assessed skill — the decay signal plus the evidence behind it. */
export interface SkillFreshnessRecord {
  skill_id: string;
  name: string;
  status: SkillStatus;
  /** The signature hashes of the failures the skill cites (deduped, in stored order). */
  signatures: string[];
  /** Cited failures whose payload could not be re-read (missing or superseded) — never silent. */
  unresolved_failure_ids: string[];
  /** Cited signatures still present in the recent failure pool. */
  recurring_signatures: string[];
  /** True when NO cited signature recurs — the decay signal (reported, never a silent flip). */
  stale: boolean;
  /** The most recent occurrence among the recurring signatures, when any. */
  last_recurred_at: string | null;
}

export interface SkillFreshnessReport {
  ran_at: string;
  scope: { project_id: string | null };
  /** The recent failure pool the pass scanned (truncated: the read cap was reached). */
  pool: { failures: number; truncated: boolean };
  skills: {
    assessed: number;
    stale: number;
    fresh: number;
    records: SkillFreshnessRecord[];
  };
  /** Degradations and unreadable evidence — never silent (memory-model.md §1.6). */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Usage tracking (M15 AC5 — the read side only; the write side is a future session hook)
// ---------------------------------------------------------------------------

/**
 * The minimal captured-event projection the usage hook reads — the session-capture flow's raw
 * `events` log (kind + session + timestamp + payload). Read-only: M15 plumbs the read side so a
 * FUTURE session-end hook can record `usage_count` / `success_rate` per skill without new SQL.
 */
export interface SkillUsageEvent {
  id: string;
  kind: string;
  session_id: string | null;
  occurred_at: string;
  /** The captured payload (redacted at ingest — never secrets, ADR-0007). */
  payload: unknown;
}

/** The per-skill usage snapshot the hook computes — what a future session would write. */
export interface SkillUsageSnapshot {
  skill_id: string;
  name: string;
  /** Captured events that reference the skill (name or path in the payload). */
  mentions: number;
  /** Distinct sessions those mentions came from. */
  sessions: number;
  last_used_at: string | null;
  /** The skills row's current counters (the write side is future work — read-only today). */
  usage_count: number;
  success_rate: number | null;
}

// ---------------------------------------------------------------------------
// The SkillStore port (storage implements; the only package with SQL)
// ---------------------------------------------------------------------------

export interface SkillStore {
  /**
   * Current failure rows for the recurrence pool: failures joined to their memories (entity
   * bindings + evidence hydrated), ordered by signature then recency, bounded by `limit`.
   */
  listFailureRecurrences(options: {
    scope?: { project_id?: string };
    limit: number;
    now?: string;
  }): Promise<FailureRecurrence[]>;
  /**
   * Insert a candidate (or later-stage row) with its `created` audit event in ONE transaction.
   * `status` must satisfy the transition machine from nothing (in practice: `candidate`).
   */
  insertSkill(
    candidate: NewSkill,
    options: { actor: string; at?: string },
  ): Promise<SkillRecord>;
  getSkill(id: string): Promise<SkillRecord | null>;
  /** The idempotency probe: a skill with this name in this project, any status. */
  findSkillByName(name: string, scope: { project_id?: string | null }): Promise<SkillRecord | null>;
  /** Skills in scope, newest-updated first (statuses omitted = every status). */
  listSkills(options: {
    scope?: { project_id?: string | null };
    statuses?: readonly SkillStatus[];
    limit?: number;
  }): Promise<SkillRecord[]>;
  /**
   * ONE transaction: guarded status update (`WHERE id AND status = from`) + the `memory_events`
   * audit row carrying the skill transition in `details` (provenance rule — same audit path as
   * every memory transition). Throws `InvalidSkillTransitionError` on an illegal edge before any
   * SQL runs, and a not-found error when the row is missing or already moved on.
   */
  updateSkillStatus(
    id: string,
    to: SkillStatus,
    options: { actor: string; note?: string; details?: Record<string, unknown>; at?: string },
  ): Promise<SkillRecord>;
  /**
   * Refresh an existing candidate's evidence (new failures of the same signature) + the `edited`
   * audit row — one transaction. Only legal while the skill is still a `candidate`.
   */
  refreshSkillEvidence(
    id: string,
    next: { failure_ids: readonly string[]; description: string; verification: { evidence: EvidenceSpan[]; verified_at: string } },
    options: { actor: string; added_failure_ids: readonly string[]; at?: string },
  ): Promise<SkillRecord>;
  /**
   * The usage hook's read side (AC5): the newest captured session events, read-only — the raw
   * `events` log the adapters' session capture wrote. Never writes.
   */
  listSessionEventsForUsage(options: {
    scope?: { project_id?: string | null };
    limit: number;
  }): Promise<SkillUsageEvent[]>;
}
