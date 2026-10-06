/**
 * `runSkillGeneration` — the M15 skill-generation pass: ONE callable, deterministic, idempotent
 * entry over the `SkillStore` port (core declares the port; storage is the only package with SQL;
 * the EventsCompactor / digest precedent). What one run does:
 *
 *   1. SCAN  the failure recurrence pool (bounded by `poolLimit`, current window only);
 *   2. MATCH signature groups — the same extraction-stage `signature_hash`, in the same scope,
 *      against the same primary entity (the pure matcher; no new clustering, `pairKey`-certified
 *      solution equivalence);
 *   3. GATE  every group: ≥ 2 solved occurrences with pairwise-equivalent solutions AND ≥ 1
 *      verification evidence (memory-model.md §9; ADR-0009 rules 1–2). Blocked groups are
 *      reported with typed reasons — never silently dropped;
 *   4. WRITE skill CANDIDATES — insert on first qualification, refresh the evidence of an
 *      existing candidate when new failures joined its group, `unchanged` otherwise. Never a
 *      promotion: promotion is the `onemem skills review` flow (a human in the loop), and every
 *      mutation lands with its `memory_events` audit row in the same transaction.
 *
 * Idempotent: a second run over unchanged failures reports all-`unchanged` (the name/slug
 * derivation is deterministic and the existing-candidate probe is by (project, name)). Bounded:
 * the pool read is capped; a truncated scan is reported, never silent. Zero model calls, zero
 * network — the pass is deterministic text assembly over durable rows (AGENTS.md rules 4 and 7).
 */

import type {
  SkillBlockedGroup,
  SkillCandidateRecord,
  SkillGenerationReport,
  SkillRecord,
  SkillStore,
} from '@onememory/core';
import {
  resolveSkillGenerationConfig,
  type SkillGenerationConfigInput,
} from '@onememory/core';

import { errorMessage } from '../util';
import { buildSkillCandidate } from './generate';
import { groupFailuresBySignature, observationOf, type SignatureGroup } from './match';

/** The audit actor for every generation mutation (the `skillify` job's own vocabulary). */
export const SKILL_GENERATION_ACTOR = 'job:skillify';

/** Blocked-group samples the report carries (counts stay exact, samples explain them). */
const MAX_BLOCKED_SAMPLES = 50;

/** Per-candidate records the report carries (a big pool is sampled, never truncated silently). */
const MAX_CANDIDATE_RECORDS = 20;

/** What `runSkillGeneration` needs. */
export interface SkillGenerationInput {
  /** The storage port implementation (`createSkillStore(db)` from `@onememory/storage`). */
  skills: SkillStore;
  /** Project scope: a project id runs one project's pass; `undefined` runs every scope. */
  scope?: { project_id?: string };
  /** Audit actor for every mutation (default `job:skillify`). */
  actor?: string;
  /** Injectable clock (tests / deterministic runs). */
  now?: () => Date;
  config?: SkillGenerationConfigInput;
}

export async function runSkillGeneration(input: SkillGenerationInput): Promise<SkillGenerationReport> {
  const config = resolveSkillGenerationConfig(input.config);
  const now = input.now ?? (() => new Date());
  const nowIso = now().toISOString();
  const actor = input.actor ?? SKILL_GENERATION_ACTOR;
  const scope = input.scope;
  const warnings: string[] = [];

  const base = {
    ran_at: nowIso,
    actor,
    scope: { project_id: scope?.project_id ?? null },
  };

  // --- 1. scan ---------------------------------------------------------------
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
      groups: { considered: 0, qualified: 0, blocked: 0 },
      candidates: { created: 0, refreshed: 0, unchanged: 0, records: [] },
      blocked: [],
      warnings: [`failure recurrence scan failed: ${errorMessage(error)}`],
    };
  }
  const truncated = pool.length >= config.poolLimit;
  if (truncated) {
    warnings.push(
      `the scan visited ${pool.length} failures (the pool cap) — older or later rows await the ` +
        'next pass (generation is idempotent)',
    );
  }

  // --- 2. match ---------------------------------------------------------------
  const groups = groupFailuresBySignature(pool.map(observationOf), {
    minFailures: config.minFailures,
    solutionSimilarity: config.solutionSimilarity,
  });
  const qualified = groups.filter((group) => group.qualified);

  // Existing skills in scope — the name-collision set and the refresh probe, read once.
  const existing = await input.skills.listSkills({
    ...(scope?.project_id === undefined ? {} : { scope: { project_id: scope.project_id } }),
    limit: config.poolLimit,
  });
  const byScopeName = new Map(
    existing.map((skill) => [`${skill.project_id ?? '∅'}|${skill.name}`, skill]),
  );

  // --- 3. gate + 4. write -------------------------------------------------------
  const created: SkillCandidateRecord[] = [];
  const refreshed: SkillCandidateRecord[] = [];
  const unchanged: SkillCandidateRecord[] = [];
  let recordsCapped = false;
  const blocked: SkillBlockedGroup[] = [];
  const blockedCounts = new Map<string, number>();
  let blockedCapped = false;

  for (const group of groups) {
    if (!group.qualified) {
      const entry: SkillBlockedGroup = {
        signature_hash: group.signature_hash,
        entity: group.entity,
        scope: group.scope,
        reason: group.reason!,
        detail: group.detail,
        failures: group.failures.length,
      };
      blockedCounts.set(entry.reason, (blockedCounts.get(entry.reason) ?? 0) + 1);
      if (blocked.length < MAX_BLOCKED_SAMPLES) blocked.push(entry);
      else blockedCapped = true;
      continue;
    }

    const record = await processQualifiedGroup(input.skills, group, byScopeName, {
      actor,
      at: nowIso,
      maxEvidenceFailures: config.maxEvidenceFailures,
    }).catch((error: unknown) => {
      // One group's failure never aborts the pass (the compaction batch discipline): the
      // group keeps its failures, the next run retries it — idempotent.
      warnings.push(
        `candidate for signature ${group.signature_hash} (${group.entity ?? 'no entity'}) ` +
          `failed: ${errorMessage(error)}`,
      );
      return null;
    });
    if (record === null) continue;
    if (record.outcome === 'created') created.push(record);
    else if (record.outcome === 'refreshed') refreshed.push(record);
    else unchanged.push(record);
  }

  const allRecords = [...created, ...refreshed, ...unchanged];
  const records = allRecords.slice(0, MAX_CANDIDATE_RECORDS);
  if (allRecords.length > records.length) {
    recordsCapped = true;
    warnings.push(
      `report detail capped at ${MAX_CANDIDATE_RECORDS} candidate records — the counts stay exact`,
    );
  }

  // The honest tail: blocked-gate explanations, capped samples — never silent.
  for (const [reason, count] of blockedCounts) {
    warnings.push(`${count} signature group${count === 1 ? '' : 's'} blocked: ${reason}`);
  }
  if (blockedCapped) {
    warnings.push(`blocked-group detail capped at ${MAX_BLOCKED_SAMPLES} samples — counts stay exact`);
  }

  return {
    ...base,
    pool: { failures: pool.length, truncated },
    groups: { considered: groups.length, qualified: qualified.length, blocked: groups.length - qualified.length },
    candidates: {
      created: created.length,
      refreshed: refreshed.length,
      unchanged: unchanged.length,
      records,
    },
    blocked,
    warnings,
  };
}

/** Create / refresh / confirm one qualified group's candidate. A throw is the CALLER's warning —
 * one group's failure never aborts the pass (the compaction batch discipline). */
async function processQualifiedGroup(
  skills: SkillStore,
  group: SignatureGroup,
  byScopeName: Map<string, SkillRecord>,
  options: { actor: string; at: string; maxEvidenceFailures: number },
): Promise<SkillCandidateRecord> {
  const scopeKey = `${group.scope.project_id ?? '∅'}`;
  const takenNames = new Set(
    [...byScopeName.keys()]
      .filter((key) => key.startsWith(`${scopeKey}|`))
      .map((key) => key.slice(scopeKey.length + 1)),
  );
  const draft = buildSkillCandidate({
    group,
    takenNames,
    maxEvidenceFailures: options.maxEvidenceFailures,
  });
  const record = (
    outcome: SkillCandidateRecord['outcome'],
    skillId: string,
  ): SkillCandidateRecord => ({
    skill_id: skillId,
    name: draft.name,
    path: draft.path,
    outcome,
    signature_hash: group.signature_hash,
    entity: group.entity,
    failure_ids: draft.source.failure_ids,
    markdown: draft.markdown,
  });

  const existing = byScopeName.get(`${scopeKey}|${draft.name}`);
  if (existing === undefined) {
    const skill = await skills.insertSkill(
      {
        ...(group.scope.project_id === null ? {} : { project_id: group.scope.project_id }),
        name: draft.name,
        description: draft.description,
        version: draft.version,
        source: draft.source,
        verification: draft.verification,
        path: draft.path,
      },
      { actor: options.actor, at: options.at },
    );
    byScopeName.set(`${scopeKey}|${draft.name}`, skill);
    return record('created', skill.id);
  }

  // A promoted/verified/deprecated skill with this name is already served (or retired): its
  // SKILL.md is the frozen artifact — never touched by the generator.
  if (existing.status !== 'candidate') {
    return record('unchanged', existing.id);
  }

  const previousIds = new Set(existing.source.failure_ids);
  const added = draft.source.failure_ids.filter((id) => !previousIds.has(id));
  if (added.length === 0) return record('unchanged', existing.id);

  await skills.refreshSkillEvidence(
    existing.id,
    {
      failure_ids: draft.source.failure_ids,
      description: draft.description,
      verification: draft.verification,
    },
    { actor: options.actor, added_failure_ids: added, at: options.at },
  );
  return record('refreshed', existing.id);
}
