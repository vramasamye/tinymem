/**
 * The review queue (M15 issue 2 — the `onemem skills review` / `promote` backend): load a skill
 * row, rebuild its SKILL.md from the CURRENT failure evidence, and surface the audit trail.
 *
 * Read path only — this module never mutates. The promotion's status flip rides the `SkillStore`
 * port's audited `updateSkillStatus` (the CLI calls it, then writes the rendered bytes), so the
 * review bundle's `markdown` is byte-identical to what promote writes: the SAME builder and
 * renderer, over the same rows (canonical form — AC2's idempotency holds end to end).
 */

import type { MemoryEventRecord, SkillRecord, SkillStore, Store } from '@onememory/core';

import { buildSkillDocument, observationFromMemory } from './generate';
import type { FailureObservation } from './match';
import { renderSkillMarkdown } from './render';

/** Everything `onemem skills review` prints and `promote` needs, in one read. */
export interface SkillReviewBundle {
  skill: SkillRecord;
  /** The rebuilt observations of `skill.source.failure_ids`, in the stored order. */
  failures: FailureObservation[];
  /** The canonical SKILL.md bytes (the exact bytes promote writes). */
  markdown: string;
  /** The audit trail read back through the same `memory_events` path every memory uses. */
  audit: MemoryEventRecord[];
  /** Failures the review could NOT rebuild (missing or no longer a failure payload) — never
   * silent: the bundle reports them and the document notes the gap. */
  unresolved_failure_ids: string[];
}

/**
 * Load the review bundle for one skill. Returns null when the skill id is unknown. The failure
 * memories are read through the Store's `getMemory` (payload + entities hydrated — the same
 * read path `onemem inspect` uses), the audit trail through `listMemoryEvents` (the skills
 * audit rows carry the skill's id as `memory_id` — the table is FK-less by design).
 */
export async function loadSkillForReview(input: {
  skills: SkillStore;
  store: Pick<Store, 'getMemory' | 'listMemoryEvents'>;
  skillId: string;
}): Promise<SkillReviewBundle | null> {
  const skill = await input.skills.getSkill(input.skillId);
  if (skill === null) return null;

  const failures: FailureObservation[] = [];
  const unresolved: string[] = [];
  for (const failureId of skill.source.failure_ids) {
    const memory = await input.store.getMemory(failureId);
    const observation = memory === null ? null : observationFromMemory(memory);
    if (observation === null) {
      unresolved.push(failureId);
      continue;
    }
    failures.push(observation);
  }

  const document = buildSkillDocument({
    name: skill.name,
    description: skill.description,
    version: skill.version,
    failures,
  });
  if (unresolved.length > 0) {
    document.known_failure_modes.push(
      `${unresolved.length} source failure${unresolved.length === 1 ? '' : 's'} could not be ` +
        're-read (missing or superseded) — the document reflects the resolvable evidence',
    );
  }

  return {
    skill,
    failures,
    markdown: renderSkillMarkdown(document),
    audit: await input.store.listMemoryEvents(skill.id),
    unresolved_failure_ids: unresolved,
  };
}
