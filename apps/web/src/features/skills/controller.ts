/**
 * The skills surface.
 *
 * Two sources, both from the API: the `skills` table (the review queue, from
 * `GET /v1/projects/{id}/skills`; each row links to `/skills/:skillId/review`), and
 * procedural memories carrying a `SkillPayload`. For the latter this mirrors the
 * engine's own convention for that mapping: the MCP surface maps kind
 * `skill` → types `['procedural']`, and the API's typed-list endpoints synthesize
 * their query from the kind (`query: options.query ?? kind`). Then one bounded
 * inspect per result keeps only memories whose payload parses as a skill payload
 * — everything else stays honestly listed as a procedural memory.
 */

import type { ApiClient } from '../../api/client';
import {
  SkillPayloadSchema,
  type MemorySearchResponse,
  type SkillPayload,
  type SkillSummary,
} from '../../api/schemas';

/** How many results get inspected (bounded N+1 — a local-first viewer). */
export const SKILL_INSPECT_CAP = 10;

export interface SkillCard {
  readonly memoryId: string;
  readonly label: string;
  readonly memoryStatus: string;
  readonly skill: SkillPayload;
  readonly evidenceCount: number;
}

export interface SkillsViewModel {
  /** The `skills` table rows (the review queue): candidates first, then the API order. */
  readonly queue: readonly SkillSummary[];
  /** How many candidates await review. */
  readonly pendingReview: number;
  readonly querySent: string;
  /** Procedural memories the search returned. */
  readonly procedural: MemorySearchResponse['memories'];
  /** The subset whose inspect payload is a skill payload. */
  readonly skills: SkillCard[];
  /** Procedural memories whose inspect failed individually (ids only). */
  readonly inspectFailures: readonly string[];
  readonly tokens: MemorySearchResponse['tokens'];
  readonly warnings: MemorySearchResponse['warnings'];
}

export async function loadSkills(
  api: ApiClient,
  projectId: string,
  cap: number = SKILL_INSPECT_CAP,
): Promise<SkillsViewModel> {
  const [list, search] = await Promise.all([
    api.listSkills(projectId),
    api.search(projectId, {
      query: 'skill',
      types: ['procedural'],
      explain: false,
      max_memories: cap,
    }),
  ]);
  const candidates = list.skills.filter((skill) => skill.status === 'candidate');
  const queue = [...candidates, ...list.skills.filter((skill) => skill.status !== 'candidate')];

  const inspections = await Promise.all(
    search.memories.slice(0, cap).map(async (memory) => {
      try {
        return { ok: true as const, memory, inspect: await api.inspect(projectId, memory.id) };
      } catch {
        return { ok: false as const, memory };
      }
    }),
  );

  const skills: SkillCard[] = [];
  const inspectFailures: string[] = [];
  for (const result of inspections) {
    if (!result.ok) {
      inspectFailures.push(result.memory.id);
      continue;
    }
    const payload = result.inspect.memory.payload;
    if (payload === undefined) continue;
    const parsed = SkillPayloadSchema.safeParse(payload);
    if (!parsed.success) continue;
    skills.push({
      memoryId: result.memory.id,
      label: result.memory.title ?? result.memory.summary,
      memoryStatus: result.memory.temporal.status,
      skill: parsed.data,
      evidenceCount: parsed.data.verification.evidence.length,
    });
  }

  return {
    queue,
    pendingReview: candidates.length,
    querySent: 'skill',
    procedural: search.memories,
    skills,
    inspectFailures,
    tokens: search.tokens,
    warnings: [...list.warnings, ...search.warnings],
  };
}
