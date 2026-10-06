/**
 * The quality dashboard.
 *
 * What the API actually exposes today:
 * - authoritative counts: `/v1/stats` (`memories.by_status`, `by_type`, `total`);
 * - query-scoped samples: search with `include` status filters (there is no
 *   "list by status" endpoint — every list is a query away, so samples are labeled
 *   with the query they matched);
 * - per-memory quality fields (`confidence`, `access_count`): only via `inspect`,
 *   so the first sample rows get a bounded inspect enrichment. The classification
 *   thresholds are stated in the UI (they are view policy over API values).
 *
 * Duplicates are NOT derivable from any current endpoint (near-dup groups live in
 * consolidation, M14/M15 scope) — the dashboard says so instead of inventing a
 * number. A `/v1/quality` endpoint is the coordinator follow-up (mission report).
 */

import type { ApiClient } from '../../api/client';
import type { MemorySearchResponse, StatsResponse } from '../../api/schemas';

/** Rows inspected for the confidence / usage categories (bounded N+1). */
export const QUALITY_INSPECT_CAP = 10;
/** View policy, stated in the UI: below this API confidence a memory is "low-confidence". */
export const LOW_CONFIDENCE_THRESHOLD = 0.5;

export type QualitySample = Pick<MemorySearchResponse, 'memories' | 'tokens' | 'warnings'> & {
  readonly querySent: string;
};

export interface QualityInsightRow {
  readonly memoryId: string;
  readonly label: string;
  readonly status: string;
  readonly confidence: number;
  readonly accessCount: number;
  readonly lowConfidence: boolean;
  readonly unused: boolean;
}

export interface QualityViewModel {
  readonly stats: StatsResponse;
  readonly staleSample: QualitySample;
  readonly disputedSample: QualitySample;
  readonly supersededSample: QualitySample;
  readonly insights: QualityInsightRow[];
  readonly inspectFailures: readonly string[];
  /** False today — the REST API exposes no duplicate groups (M14/M15 consolidation scope). */
  readonly duplicatesAvailable: false;
  readonly warnings: readonly string[];
}

const sample = (
  response: MemorySearchResponse,
  querySent: string,
): QualitySample => ({
  querySent,
  memories: response.memories,
  tokens: response.tokens,
  warnings: response.warnings,
});

export async function loadQuality(
  api: ApiClient,
  projectId: string,
  fallbackQuery: string,
  cap: number = QUALITY_INSPECT_CAP,
): Promise<QualityViewModel> {
  const querySent = fallbackQuery;
  const [stats, stale, disputed, superseded] = await Promise.all([
    api.stats(projectId),
    api.search(projectId, { query: querySent, include: ['stale'], max_memories: cap, explain: false }),
    api.search(projectId, { query: querySent, include: ['disputed'], max_memories: cap, explain: false }),
    api.search(projectId, { query: querySent, include: ['superseded'], max_memories: cap, explain: false }),
  ]);

  // Enrichment pool: the first rows of the actionable samples (stale + disputed).
  const pool = [...stale.memories, ...disputed.memories].slice(0, cap);
  const inspections = await Promise.all(
    pool.map(async (memory) => {
      try {
        return { ok: true as const, memory, inspect: await api.inspect(projectId, memory.id) };
      } catch {
        return { ok: false as const, memory };
      }
    }),
  );

  const insights: QualityInsightRow[] = [];
  const inspectFailures: string[] = [];
  for (const result of inspections) {
    if (!result.ok) {
      inspectFailures.push(result.memory.id);
      continue;
    }
    const record = result.inspect.memory;
    insights.push({
      memoryId: record.id,
      label: record.title ?? record.content_summary ?? record.content,
      status: record.status,
      confidence: record.confidence,
      accessCount: record.access_count,
      lowConfidence: record.confidence < LOW_CONFIDENCE_THRESHOLD,
      unused: record.access_count === 0,
    });
  }

  return {
    stats,
    staleSample: sample(stale, querySent),
    disputedSample: sample(disputed, querySent),
    supersededSample: sample(superseded, querySent),
    insights,
    inspectFailures,
    duplicatesAvailable: false,
    warnings: [...stats.warnings, ...stale.warnings, ...disputed.warnings, ...superseded.warnings],
  };
}
