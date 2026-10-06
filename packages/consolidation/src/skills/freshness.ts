/**
 * `runSkillFreshness` — the M15 skill-validity / decay pass (backlog follow-up 2). ONE callable,
 * deterministic, READ-ONLY entry over the `SkillStore` port plus the Store's `getMemory` (the
 * same two ports `loadSkillForReview` uses).
 *
 * What it answers: for every SERVED skill (`verified` / `promoted`), does the failure signature it
 * was distilled from still recur in the recent failure pool? A skill whose signature stopped
 * recurring is a candidate for deprecation — the decay signal Memp's lifecycle calls for.
 *
 * What it deliberately does NOT do: flip anything. ADR-0009 rule 4 says deprecation mirrors
 * explicit deprecation, not silent removal, and `verified → candidate` is not a legal edge in the
 * lifecycle machine (a served artifact never silently reverts to the review queue). So this pass
 * REPORTS; `onemem skills deprecate <id>` performs the audited `→ deprecated` flip.
 *
 * Honest edges, never silent:
 *   - cited failures whose payload can no longer be read (missing/superseded) are counted in
 *     `unresolved_failure_ids` and warned about — they are excluded from the signature set;
 *   - a skill whose ENTIRE signature set is unresolvable is NOT reported stale (we cannot know) —
 *     it is reported with an empty signature list and a warning, so the operator can re-review;
 *   - a truncated pool scan is reported, never silently narrowing the "still recurring" answer.
 *
 * Zero model calls, zero network — deterministic set arithmetic over durable rows.
 */

import type { SkillRecord, SkillStatus, SkillStore, SkillFreshnessReport } from '@onememory/core';
import { resolveSkillFreshnessConfig, type SkillFreshnessConfigInput } from '@onememory/core';
import type { Store } from '@onememory/core';

import { errorMessage } from '../util';

/** The lifecycle stages this pass assesses: the ones actually SERVED to agents. */
export const SERVED_SKILL_STATUSES: readonly SkillStatus[] = ['verified', 'promoted'];

/** Report records carried per pass (counts stay exact; a big fleet is sampled). */
const MAX_RECORDS = 50;

export interface SkillFreshnessInput {
  /** The storage port implementation (`createSkillStore(db)` from `@onememory/storage`). */
  skills: SkillStore;
  /** The memory read used to resolve each cited failure's signature (`Store.getMemory`). */
  store: Pick<Store, 'getMemory'>;
  /** Project scope: a project id assesses one project; `undefined` assesses every scope. */
  scope?: { project_id?: string };
  /** Injectable clock (tests / deterministic runs). */
  now?: () => Date;
  config?: SkillFreshnessConfigInput;
}

/** The failure signature a cited failure carries, or null when the row is not a readable failure. */
function signatureOf(memory: { payload?: unknown } | null): string | null {
  const payload = memory?.payload;
  if (payload === undefined || payload === null || typeof payload !== 'object') return null;
  const hash = (payload as { signature_hash?: unknown }).signature_hash;
  return typeof hash === 'string' && hash.length > 0 ? hash : null;
}

/** Resolve one skill's signature set + the cited failures that could not be read. */
async function signaturesForSkill(
  store: Pick<Store, 'getMemory'>,
  skill: SkillRecord,
): Promise<{ signatures: string[]; unresolved: string[] }> {
  const signatures: string[] = [];
  const seen = new Set<string>();
  const unresolved: string[] = [];
  for (const failureId of skill.source.failure_ids) {
    const signature = signatureOf(await store.getMemory(failureId).catch(() => null));
    if (signature === null) {
      unresolved.push(failureId);
      continue;
    }
    if (seen.has(signature)) continue;
    seen.add(signature);
    signatures.push(signature);
  }
  return { signatures, unresolved };
}

export async function runSkillFreshness(input: SkillFreshnessInput): Promise<SkillFreshnessReport> {
  const config = resolveSkillFreshnessConfig(input.config);
  const now = input.now ?? (() => new Date());
  const nowIso = now().toISOString();
  const scope = input.scope;
  const warnings: string[] = [];
  const base = { ran_at: nowIso, scope: { project_id: scope?.project_id ?? null } };

  // --- 1. the recent failure pool: which signatures are still recurring ------------------
  let pool: Awaited<ReturnType<SkillStore['listFailureRecurrences']>>;
  try {
    pool = await input.skills.listFailureRecurrences({
      ...(scope?.project_id === undefined ? {} : { scope: { project_id: scope.project_id } }),
      limit: config.poolLimit,
      now: nowIso,
    });
  } catch (error) {
    return {
      ...base,
      pool: { failures: 0, truncated: false },
      skills: { assessed: 0, stale: 0, fresh: 0, records: [] },
      warnings: [`failure recurrence scan failed: ${errorMessage(error)}`],
    };
  }
  const truncated = pool.length >= config.poolLimit;
  if (truncated) {
    warnings.push(
      `the pool scan visited ${pool.length} failures (the cap) — a signature absent here may ` +
        'still recur; raise skills.freshness.pool_limit or re-run',
    );
  }
  // The most recent occurrence per signature, so the report can say WHEN it last recurred.
  const lastSeenBySignature = new Map<string, string>();
  for (const failure of pool) {
    const previous = lastSeenBySignature.get(failure.signature_hash);
    if (previous === undefined || failure.last_seen_at > previous) {
      lastSeenBySignature.set(failure.signature_hash, failure.last_seen_at);
    }
  }

  // --- 2. the served skills ----------------------------------------------------------------
  const served = (
    await input.skills.listSkills({
      ...(scope?.project_id === undefined ? {} : { scope: { project_id: scope.project_id } }),
      statuses: SERVED_SKILL_STATUSES,
      limit: config.skillLimit,
    })
  ).slice(0, config.skillLimit);

  // --- 3. assess --------------------------------------------------------------------------
  const records = [];
  let staleCount = 0;
  for (const skill of served) {
    const { signatures, unresolved } = await signaturesForSkill(input.store, skill);
    const recurring = signatures.filter((signature) => lastSeenBySignature.has(signature));
    // A skill with NO resolvable signature cannot be judged: report it, never call it stale.
    const stale = signatures.length > 0 && recurring.length === 0;
    if (stale) staleCount += 1;
    if (unresolved.length > 0) {
      warnings.push(
        `skill ${skill.name}: ${unresolved.length} cited failure${unresolved.length === 1 ? '' : 's'} ` +
          'could not be re-read (missing or superseded) — excluded from the signature set',
      );
    }
    if (signatures.length === 0) {
      warnings.push(
        `skill ${skill.name}: no resolvable signature — cannot judge freshness; re-review it ` +
          "('onemem skills review <id>')",
      );
    }
    records.push({
      skill_id: skill.id,
      name: skill.name,
      status: skill.status,
      signatures,
      unresolved_failure_ids: unresolved,
      recurring_signatures: recurring,
      stale,
      last_recurred_at:
        recurring
          .map((signature) => lastSeenBySignature.get(signature)!)
          .sort()
          .at(-1) ?? null,
    });
  }

  const capped = records.slice(0, MAX_RECORDS);
  if (records.length > capped.length) {
    warnings.push(`report detail capped at ${MAX_RECORDS} skill records — the counts stay exact`);
  }

  return {
    ...base,
    pool: { failures: pool.length, truncated },
    skills: {
      assessed: records.length,
      stale: staleCount,
      fresh: records.length - staleCount,
      records: capped,
    },
    warnings,
  };
}
