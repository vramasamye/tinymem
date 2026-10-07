/**
 * `onemem stats` / `GET /v1/projects/:id/stats`.
 *
 * Honest by construction: everything reported comes from a real read, and what cannot be read
 * through the existing APIs is reported as `null` **with a warning naming the missing API** instead
 * of a plausible-looking zero. Two such gaps exist today and are recorded in the M13 report:
 * a job queue count API, and an aggregate working-memory depth API.
 */

import { MEMORY_STATUSES, DURABLE_MEMORY_TYPES } from '@onememory-ai/core';

import type { OnememoryRuntime } from './composition';
import { PROJECT_MEMORY_READ_LIMIT, listProjectMemories, requireProject } from './memory-service';
import { llmProfileSummary } from '@onememory-ai/config';
import type { StatsResult } from './types';

export interface StatsOptions {
  /** Working memory is session-scoped: depth is only reportable for a named session. */
  session_id?: string;
}

export async function computeStats(
  runtime: OnememoryRuntime,
  projectId: string,
  options: StatsOptions = {},
): Promise<StatsResult> {
  await requireProject(runtime, projectId);

  const warnings: string[] = [];
  const byStatus: Record<string, number> = {};
  const byType: Record<string, number> = {};
  let total = 0;
  let truncated = false;

  for (const status of MEMORY_STATUSES) {
    const rows = await listProjectMemories(runtime, projectId, {
      statuses: [status],
      limit: PROJECT_MEMORY_READ_LIMIT,
    });
    byStatus[status] = rows.length;
    total += rows.length;
    if (rows.length >= PROJECT_MEMORY_READ_LIMIT) truncated = true;
    for (const row of rows) {
      byType[row.type] = (byType[row.type] ?? 0) + 1;
    }
  }
  if (truncated) {
    warnings.push(
      `counts are a lower bound: a status holds ${PROJECT_MEMORY_READ_LIMIT} or more memories (the read cap)`,
    );
  }
  for (const type of DURABLE_MEMORY_TYPES) byType[type] ??= 0;

  let working: StatsResult['working_memory'] = null;
  if (options.session_id !== undefined) {
    const rows = await runtime.storage.store.listWorking(options.session_id);
    working = { session_id: options.session_id, depth: rows.length };
  } else {
    warnings.push(
      'working-memory depth not reported: working memory is session-scoped and @onememory-ai/storage exposes no aggregate API (pass --session <id>)',
    );
  }

  warnings.push(
    'job queue statistics unavailable: @onememory-ai/core\u2019s JobQueue port and @onememory-ai/storage expose no job-count API (coordinator follow-up, see the mission-13 report)',
  );

  return {
    project_id: projectId,
    storage: {
      profile: runtime.storage.profile,
      vector_backend: runtime.storage.vectors.backend,
      vector_model: runtime.storage.vectors.model,
      vector_dim: runtime.storage.vectors.dim,
      data_dir: runtime.storage.profile === 'embedded' ? runtime.loaded.paths.data_dir : null,
    },
    memories: { total, by_status: byStatus, by_type: byType, truncated },
    working_memory: working,
    jobs: null,
    cache: runtime.engine.cacheStats(),
    llm: llmProfileSummary(runtime.config),
    warnings: [...warnings, ...runtime.warnings],
  };
}
