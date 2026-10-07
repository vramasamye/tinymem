/**
 * `memory_skills` serving (M15 — backlog "skill serving via MCP + filesystem"; ADR-0010 §2,
 * the 11-tool full surface): the token-budgeted list of a project's CONSUMABLE skills — the
 * `verified`/`promoted` rows of the `skills` table the `onemem skills promote` flow produced.
 *
 * The pre-M15 handler listed procedural memories as a stand-in ("the standalone skills payload
 * table fills in when the skillify stage lands" — it lands now); this module is the real read:
 * candidates stay out of the default list (they await review, ADR-0009 rule 2 — the operator
 * sees them through `onemem skills list`), while the runtime gets the skills whose SKILL.md is
 * on disk and consumable.
 *
 * Progressive disclosure (ADR-0010 §3): entries are one-line summaries under a token budget
 * (default 500, `DEFAULT_SKILL_SERVE_TOKENS`); when the budget binds, later entries degrade to
 * name-only (`title-only` packing) and the overflow is dropped with a warning — never silently,
 * never over budget. The full artifact lives on the filesystem (`skills/<name>/SKILL.md`) for
 * runtime-native loaders (Claude Code, OpenCode), which is exactly why the index stays lean.
 */

import { DEFAULT_SKILL_SERVE_TOKENS, estimateTokens, type SkillRecord, type SkillStatus } from '@onememory-ai/core';

import type { MemorySkillsOutput } from '../schemas';

/** The serving order: promoted first (usage-proven), then verified, newest update first. */
const STATUS_ORDER: Record<SkillStatus, number> = {
  promoted: 0,
  verified: 1,
  candidate: 2,
  deprecated: 3,
};

/** The statuses the tool serves when the caller does not filter: the consumable list. */
export const DEFAULT_SERVED_SKILL_STATUSES: readonly SkillStatus[] = ['promoted', 'verified'];

/** The entries the packed index carries. */
export type SkillIndexEntry = MemorySkillsOutput['results'][number];

/** One entry's summary estimate — the same shape every list tool estimates with. */
function entryTokens(entry: { id: string; summary: string }): number {
  return estimateTokens(`${entry.id} ${entry.summary}`);
}

/** Name-only estimate for the degraded packing mode (the search packer's `title-only` idea). */
function nameOnlyTokens(entry: { id: string; name?: string; title?: string }): number {
  return estimateTokens(`${entry.id} ${entry.name ?? entry.title ?? ''}`);
}

/**
 * Pack the skills under the token budget: summaries while they fit, name-only entries once the
 * budget binds, dropped (with an exact count) when even the name does not fit. `used ≤ budget`
 * is the hard invariant — the same one the retrieval packer enforces.
 */
export function packSkillEntries(
  skills: readonly SkillRecord[],
  budget: number,
): { results: SkillIndexEntry[]; used: number; packing: 'summary' | 'title-only'; dropped: number } {
  const results: SkillIndexEntry[] = [];
  let used = 0;
  let packing: 'summary' | 'title-only' = 'summary';
  let dropped = 0;
  for (const skill of skills) {
    const base = {
      id: skill.id,
      type: 'procedural' as const,
      name: skill.name,
      title: skill.name,
      relevance: 1,
      status: skill.status,
      version: skill.version,
      path: skill.path,
    };
    const summaryEntry: SkillIndexEntry = {
      ...base,
      summary: skill.description,
      token_estimate: entryTokens({ id: skill.id, summary: skill.description }),
    };
    if (used + summaryEntry.token_estimate <= budget) {
      results.push(summaryEntry);
      used += summaryEntry.token_estimate;
      continue;
    }
    // Budget binds: degrade this entry to name-only (the description stays on the artifact).
    const nameTokens = nameOnlyTokens(base);
    const nameSummary = skill.name;
    if (used + nameTokens <= budget) {
      results.push({ ...base, summary: nameSummary, token_estimate: nameTokens });
      used += nameTokens;
      packing = 'title-only';
      continue;
    }
    dropped += 1;
  }
  return { results, used, packing, dropped };
}

/** Deterministic serving order: status class, then usage, then newest update. */
export function servingOrder(skills: readonly SkillRecord[]): SkillRecord[] {
  return [...skills].sort((a, b) => {
    const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (byStatus !== 0) return byStatus;
    if (a.usage_count !== b.usage_count) return b.usage_count - a.usage_count;
    if (a.updated_at !== b.updated_at) return a.updated_at < b.updated_at ? 1 : -1;
    return a.id < b.id ? -1 : 1;
  });
}

/**
 * Serve one project's skills. Reads ONLY through the `SkillStore` port (`storage.skills` —
 * SQL stays in packages/storage), packs under the budget, and reports drops and degradation as
 * warnings — the exact discipline every other list tool follows.
 */
export function serveProjectSkills(
  storage: { skills: Pick<import('@onememory-ai/core').SkillStore, 'listSkills'> },
  input: {
    projectId: string;
    limit?: number;
    maxTokens?: number;
    statuses?: readonly SkillStatus[];
  },
): Promise<MemorySkillsOutput> {
  const limit = input.limit ?? 10;
  const budget = input.maxTokens ?? DEFAULT_SKILL_SERVE_TOKENS;
  const statuses = input.statuses === undefined || input.statuses.length === 0
    ? DEFAULT_SERVED_SKILL_STATUSES
    : input.statuses;
  return storage.skills
    .listSkills({ scope: { project_id: input.projectId }, statuses, limit: limit * 2 })
    .then((rows) => {
      const ordered = servingOrder(rows).slice(0, limit);
      const packed = packSkillEntries(ordered, budget);
      const warnings: string[] = [];
      if (packed.dropped > 0) {
        warnings.push(
          `${packed.dropped} skill${packed.dropped === 1 ? '' : 's'} dropped: the ` +
            `max_tokens budget (${budget}) bound the list — raise max_tokens for the full set`,
        );
      }
      if (packed.packing === 'title-only') {
        warnings.push(
          'the token budget bound the list: some entries carry the name only ' +
            '(summary dropped) — the full descriptions live in each skills/<name>/SKILL.md',
        );
      }
      return {
        results: packed.results,
        tokens: { budget, used: packed.used, packing: packed.packing },
        warnings,
        token_estimate: packed.used,
      };
    });
}
