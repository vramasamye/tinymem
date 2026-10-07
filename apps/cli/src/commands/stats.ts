/**
 * `onemem stats` — project counts, cache state, storage and router facts. Counts hit the read
 * cap when a status is large, which the report says (`truncated`); job counts are `null` until
 * `@onememory-ai/storage` exposes a queue-count query (mission-13 report follow-up), and that gap is
 * printed rather than hidden.
 */

import { describeResolution, resolveBackend, type ResolveOptions } from '../resolve';
import type { Io } from '../io';
import type { StatsResult } from '@onememory-ai/api/runtime';

export interface StatsOptions extends ResolveOptions {}

export async function runStats(options: StatsOptions, io: Io): Promise<number> {
  const resolved = await resolveBackend(options);
  try {
    const stats = await resolved.backend.stats(resolved.projectId);
    if (resolved.mode === 'local') io.err(`note: ${describeResolution(resolved)}`);
    io.emit(stats);
    printStats(io, stats);
    return 0;
  } finally {
    await resolved.backend.close();
  }
}

export function printStats(io: Io, stats: StatsResult): void {
  io.out(`project ${stats.project_id}`);
  io.out(`storage:   ${stats.storage.profile} (${stats.storage.vector_backend}, model ${stats.storage.vector_model}, dim ${stats.storage.vector_dim})`);
  io.out(`memories:  ${stats.memories.total} total${stats.memories.truncated ? ' (read cap hit — counts are a lower bound)' : ''}`);
  const byStatus = Object.entries(stats.memories.by_status);
  if (byStatus.length > 0) {
    io.out(`  by status: ${byStatus.map(([status, count]) => `${status}=${count}`).join(', ')}`);
  }
  const byType = Object.entries(stats.memories.by_type);
  if (byType.length > 0) {
    io.out(`  by type:   ${byType.map(([type, count]) => `${type}=${count}`).join(', ')}`);
  }
  if (stats.working_memory === null) {
    io.out('working:   no session in scope (no session id passed)');
  } else {
    io.out(`working:   session ${stats.working_memory.session_id} depth ${stats.working_memory.depth}`);
  }
  io.out(
    stats.jobs === null
      ? 'jobs:      queue counts unavailable (@onememory-ai/storage has no job-count query yet)'
      : `jobs:      ${stats.jobs.pending} pending, ${stats.jobs.running} running, ${stats.jobs.dead} dead`,
  );
  io.out(
    `cache:     ${stats.cache.embeddings} embedding vectors, ${stats.cache.results} packed results, ${stats.cache.entityScopes} entity scopes`,
  );
  io.out(
    `llm:       profile ${stats.llm.profile}; routed: ${stats.llm.routed_operations.length > 0 ? stats.llm.routed_operations.join(', ') : 'none'}; unconfigured: ${stats.llm.unconfigured_operations.length > 0 ? stats.llm.unconfigured_operations.join(', ') : 'none'}`,
  );
  for (const warning of stats.warnings) io.err(`warning: ${warning}`);
}
