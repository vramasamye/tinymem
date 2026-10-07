/**
 * Decay (memory-model.md §7) — the prominence formula and the archive pass. Archive, never
 * delete: the pass is an audited `active → archived` transition per memory, with the prominence
 * decomposition recorded in the audit details.
 *
 *   prominence = effectiveImportance^0.5 × confidence
 *                × recency(age, half-life per type)
 *                × (1 + log(1 + access_count))
 *
 * - recency = 0.5^(ageDays / halfLifeDays) — the SAME half-life table retrieval scores with
 *   (`DEFAULT_HALF_LIFE_DAYS`, retrieval.md §5): episodic 30d, decision 400d, failure 180d.
 * - the access factor is ≥ 1 — reinforcement only ever raises prominence.
 * - decisions and verified procedures are decay-resistant: their importance never counts below
 *   the floor (an old decision survives; an old unverified note does not).
 */

import type { MemoryRecord, Store } from '@onememory-ai/core';

import type { ArchiveRecord } from './types';

const DAY_MS = 86_400_000;
// The fallback for a type MISSING from the shared per-type table (180 days — the same span
// retrieval gives failures). Not to be confused with retrieval's default table itself, which
// types.ts imports as CONSOLIDATION_HALF_LIFE_DAYS — the shared table decides the rate; this
// only covers a type nobody listed.
const FALLBACK_HALF_LIFE_DAYS = 180;

/** Decisions, and procedures with verification evidence, resist decay (memory-model.md §7). */
export function isDecayResistant(memory: MemoryRecord): boolean {
  if (memory.type === 'decision') return true;
  if (memory.type === 'procedural') return memory.provenance.verified_at !== undefined;
  return false;
}

/** The importance that feeds the formula: the floor for decay-resistant types, else as stored. */
export function effectiveImportance(memory: MemoryRecord, resistantImportanceFloor: number): number {
  return isDecayResistant(memory) ? Math.max(memory.importance, resistantImportanceFloor) : memory.importance;
}

/** Recency signal: 0.5^(age / half-life). A non-positive half-life means "no recency signal". */
export function recencySignal(memory: MemoryRecord, now: Date, halfLifeDays: number): number {
  if (halfLifeDays <= 0) return 0;
  const ageDays = Math.max(0, (now.getTime() - Date.parse(memory.observed_at)) / DAY_MS);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

/** The prominence formula (memory-model.md §7) — pure, deterministic, unit-tested. */
export function prominence(
  memory: MemoryRecord,
  now: Date,
  halfLifeDays: number,
  resistantImportanceFloor: number,
): number {
  const importance = effectiveImportance(memory, resistantImportanceFloor);
  const recency = recencySignal(memory, now, halfLifeDays);
  const access = memory.access_count <= 0 ? 0 : Math.log1p(memory.access_count);
  return Math.sqrt(importance) * memory.confidence * recency * (1 + access);
}

/** True when the memory's prominence fell below the archive threshold. */
export function shouldArchive(
  memory: MemoryRecord,
  now: Date,
  archiveThreshold: number,
  halfLifeDays: number,
  resistantImportanceFloor: number,
): boolean {
  return prominence(memory, now, halfLifeDays, resistantImportanceFloor) < archiveThreshold;
}

export interface DecayPassResult {
  records: ArchiveRecord[];
  /** Active memories inspected and left above the threshold. */
  kept: number;
  skipped: Array<{ id: string; reason: string }>;
  warnings: string[];
}

/**
 * The decay pass over ACTIVE memories: compute prominence; below threshold → audited
 * `active → archived`. Idempotent (archived memories leave the active pool) and per-item safe
 * (an illegal transition on one memory is skipped with a reason, never a crash of the pass).
 */
export async function runDecayPass(
  store: Store,
  pool: readonly MemoryRecord[],
  options: {
    actor: string;
    now: Date;
    archiveThreshold: number;
    resistantImportanceFloor: number;
    halfLifeDays: Record<string, number>;
  },
): Promise<DecayPassResult> {
  const records: ArchiveRecord[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  const warnings: string[] = [];

  for (const memory of pool) {
    const halfLife = options.halfLifeDays[memory.type] ?? FALLBACK_HALF_LIFE_DAYS;
    const value = prominence(memory, options.now, halfLife, options.resistantImportanceFloor);
    if (value >= options.archiveThreshold) continue;
    try {
      await store.updateMemoryStatus(memory.id, 'archived', {
        actor: options.actor,
        reason: 'decay: prominence below the archive threshold',
        details: {
          prominence: round(value),
          threshold: options.archiveThreshold,
          importance: memory.importance,
          effective_importance: effectiveImportance(memory, options.resistantImportanceFloor),
          confidence: memory.confidence,
          access_count: memory.access_count,
          half_life_days: halfLife,
          age_days: round(Math.max(0, (options.now.getTime() - Date.parse(memory.observed_at)) / DAY_MS)),
          decay_resistant: isDecayResistant(memory),
        },
      });
      records.push({
        id: memory.id,
        from_status: memory.status,
        prominence: round(value),
        threshold: options.archiveThreshold,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'InvalidTransitionError') {
        skipped.push({ id: memory.id, reason: `illegal transition ${memory.status} → archived` });
        continue;
      }
      throw error;
    }
  }
  return { records, kept: pool.length - records.length - skipped.length, skipped, warnings };
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
