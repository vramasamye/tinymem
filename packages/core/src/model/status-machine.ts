/**
 * Status transition machine (memory-model.md §4).
 *
 * Rules:
 * - Any transition is one-directional, EXCEPT `stale → active` (re-verified),
 *   `archived → active` (manual restore), and `disputed → *` (resolution).
 * - `archived` is reachable from any state (decay threshold or manual archive).
 * - Every transition produces an audited `memory_events` record (action, from/to, actor, details, at).
 * - Never delete: decay archives; `forget` is a transition; only `--purge` hard-deletes (audited).
 */

import type { MemoryEventAction, MemoryStatus } from './types';

export const ALLOWED_TRANSITIONS: Readonly<Record<MemoryStatus, readonly MemoryStatus[]>> = {
  active: ['stale', 'superseded', 'disputed', 'archived'],
  stale: ['active', 'superseded', 'archived'],
  superseded: ['archived'],
  disputed: ['active', 'stale', 'superseded', 'archived'],
  archived: ['active'],
};

export function canTransition(from: MemoryStatus, to: MemoryStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  readonly from: MemoryStatus;
  readonly to: MemoryStatus;

  constructor(from: MemoryStatus, to: MemoryStatus) {
    super(`invalid memory status transition ${from} → ${to}`);
    this.name = 'InvalidTransitionError';
    this.from = from;
    this.to = to;
  }
}

export function assertTransition(from: MemoryStatus, to: MemoryStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

/** A `memory_events` audit record as produced by the model — field names match the table columns. */
export interface MemoryEventAuditDraft {
  memory_id: string;
  action: MemoryEventAction;
  from_status: MemoryStatus | null;
  to_status: MemoryStatus | null;
  actor: string;
  details: Record<string, unknown>;
  at: string;
}

export interface TransitionInput {
  memoryId: string;
  from: MemoryStatus;
  to: MemoryStatus;
  /** `system|user:<id>|agent:<id>|job:<kind>` (database-schema.md §2). */
  actor: string;
  reason?: string;
  details?: Record<string, unknown>;
  at?: Date | string;
}

export interface TransitionResult {
  from: MemoryStatus;
  to: MemoryStatus;
  action: MemoryEventAction;
  audit: MemoryEventAuditDraft;
}

function toIso(at: Date | string | undefined): string {
  const d = at === undefined ? new Date() : at instanceof Date ? at : new Date(at);
  return d.toISOString();
}

/**
 * Apply a transition: validates it against the machine and returns the new status plus the
 * audit record the caller MUST append to `memory_events`. Throws InvalidTransitionError if the
 * edge does not exist.
 */
export function transition(input: TransitionInput): TransitionResult {
  assertTransition(input.from, input.to);
  const details: Record<string, unknown> = { ...(input.details ?? {}) };
  if (input.reason !== undefined && details.reason === undefined) details.reason = input.reason;
  const action = actionFor(input.from, input.to);
  return {
    from: input.from,
    to: input.to,
    action,
    audit: {
      memory_id: input.memoryId,
      action,
      from_status: input.from,
      to_status: input.to,
      actor: input.actor,
      details,
      at: toIso(input.at),
    },
  };
}

/** Map a transition onto the `memory_events.action` vocabulary. */
export function actionFor(from: MemoryStatus | null, to: MemoryStatus | null): MemoryEventAction {
  if (from === null) return 'created';
  if (to === null) return 'purged';
  if (to === 'archived') return 'archived';
  if (to === 'active' && from !== 'active') return 'restored';
  return 'status_changed';
}

/** The audit record for a freshly created memory (transition from nothing). */
export function creationAudit(
  memoryId: string,
  status: MemoryStatus,
  actor: string,
  at?: Date | string,
  details?: Record<string, unknown>,
): MemoryEventAuditDraft {
  return {
    memory_id: memoryId,
    action: 'created',
    from_status: null,
    to_status: status,
    actor,
    details: details ?? {},
    at: toIso(at),
  };
}
