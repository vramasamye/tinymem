/**
 * The skill usage-tracking hook client (M15 AC5) — READ SIDE ONLY. The `skills` table already
 * carries `usage_count` / `success_rate` (M2-landed columns — no schema change rides on M15);
 * what does not exist yet is the session-end writer that would record them.
 *
 * What this module plumbs today:
 *
 *   - a read-only probe over the session-capture flow (the adapters' captured `events` — the raw
 *     log every runtime's session hooks wrote, redacted at ingest, ADR-0007): which captured
 *     events mention a skill, from which sessions, and how recently;
 *   - the pure snapshot fold — exactly the numbers a FUTURE session-end hook would write back
 *     (`usage_count`, `success_rate` once success signals exist). Wiring that write side is the
 *     documented follow-up; nothing here mutates.
 *
 * `onemem skills list --usage` renders these snapshots today, so the read side is exercised
 * end to end and the future writer has a single seam to call.
 */

import type {
  SkillRecord,
  SkillStore,
  SkillUsageEvent,
  SkillUsageSnapshot,
} from '@onememory/core';

/** Bumped when the mention heuristic changes (snapshots are not persisted — read-only). */
export const SKILL_USAGE_HOOK_VERSION = 'skill-usage.v1';

/** Captured events the probe reads per pass (bounded — newest first, read-only). */
export const DEFAULT_SKILL_USAGE_EVENT_LIMIT = 200;

/** Skills the fold covers per pass (bounded, newest-updated first). */
export const DEFAULT_SKILL_USAGE_SKILL_LIMIT = 100;

/** A name must be at least this long to count as a payload mention (short slugs false-positive
 * inside ordinary prose — the floor keeps the fold honest). */
const MIN_MENTION_NAME_CHARS = 6;

/** Does the captured event reference the skill? Payload text containment — read-only, no FTS. */
export function mentionsSkill(
  skill: { name: string; path: string },
  event: SkillUsageEvent,
): boolean {
  const text = JSON.stringify(event.payload ?? {});
  if (text.includes(skill.path)) return true;
  return skill.name.length >= MIN_MENTION_NAME_CHARS && text.includes(skill.name);
}

/** Fold one skill's mentions into the snapshot a future session-end hook would write. */
export function usageSnapshotOf(
  skill: SkillRecord,
  events: readonly SkillUsageEvent[],
): SkillUsageSnapshot {
  const mentions = events.filter((event) => mentionsSkill(skill, event));
  const sessions = new Set<string>();
  let lastUsedAt: string | null = null;
  for (const event of mentions) {
    if (event.session_id !== null) sessions.add(event.session_id);
    if (lastUsedAt === null || event.occurred_at > lastUsedAt) lastUsedAt = event.occurred_at;
  }
  return {
    skill_id: skill.id,
    name: skill.name,
    mentions: mentions.length,
    sessions: sessions.size,
    last_used_at: lastUsedAt,
    usage_count: skill.usage_count,
    success_rate: skill.success_rate ?? null,
  };
}

/**
 * The hook client: read the newest captured session events ONCE, fold every listed skill's
 * snapshot from them. Read-only over the `SkillStore` port; the write side (recording
 * `usage_count` / `success_rate` from a session-end hook) is future work that plugs in here.
 */
export async function collectSkillUsage(input: {
  skills: SkillStore;
  scope?: { project_id?: string | null };
  eventLimit?: number;
  skillLimit?: number;
}): Promise<SkillUsageSnapshot[]> {
  const events = await input.skills.listSessionEventsForUsage({
    ...(input.scope === undefined ? {} : { scope: { project_id: input.scope.project_id ?? null } }),
    limit: input.eventLimit ?? DEFAULT_SKILL_USAGE_EVENT_LIMIT,
  });
  const skills = await input.skills.listSkills({
    ...(input.scope === undefined ? {} : { scope: { project_id: input.scope.project_id ?? null } }),
    limit: input.skillLimit ?? DEFAULT_SKILL_USAGE_SKILL_LIMIT,
  });
  return skills.map((skill) => usageSnapshotOf(skill, events));
}
