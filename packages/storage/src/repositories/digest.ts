/**
 * The project digest repository (backlog M14.5): the ONE write path for the renderable
 * `projects.digest` rollup the `memory_project_context` tool surface reads (retrieval's
 * session-context assembles its `digest` section from this column — retrieval.md §2
 * "projects.digest: the consolidation-built rollup").
 *
 * The update is an OWNED-NAMESPACE MERGE, one statement, atomic:
 *
 * - every `decision_NN` / `failure_NN` / `procedure_NN` key (the digest pass's namespace,
 *   `PROJECT_DIGEST_ENTRY_KEY`) is removed from the stored record — stale entries from a wider
 *   previous rollup never survive a refresh;
 * - everything else in the record (a manual `summary`, `stack`, `conventions`, …) is preserved;
 * - the new validated entries are concatenated in.
 *
 * Zod validates the input at the boundary (`ProjectDigestEntriesSchema`: the owned key
 * namespace, string one-liners — AGENTS.md rule: every external boundary is validated). The
 * caller (consolidation's digest pass) owns WHEN this runs; this repo owns HOW it is stored.
 */

import { ProjectDigestEntriesSchema, type ProjectDigestEntries, type ProjectRecord } from '@onememory/core';

import type { Database } from '../drivers/client';

import { mapProjectRow } from './row-mappers';
import { parseInput } from './util';

/**
 * Replace the digest pass's owned entry namespace inside `projects.digest` with `entries`.
 * Returns the updated project, or null when the project id does not exist (an honest skip —
 * the digest pass reports it, it does not throw on a missing project).
 */
export async function updateProjectDigest(
  db: Database,
  projectId: string,
  entries: ProjectDigestEntries,
): Promise<ProjectRecord | null> {
  const input = parseInput(ProjectDigestEntriesSchema, entries, 'updateProjectDigest');
  const result = await db.query(
    `UPDATE projects
        SET digest = (
              SELECT coalesce(jsonb_object_agg(kv.key, kv.value), '{}'::jsonb)
                FROM jsonb_each(projects.digest) AS kv
               WHERE kv.key !~ '^(decision|failure|procedure)_[0-9]{2}$'
            ) || $2::jsonb,
            updated_at = now()
      WHERE id = $1::uuid
      RETURNING *`,
    [projectId, JSON.stringify(input)],
  );
  const row = result.rows[0];
  return row ? mapProjectRow(row) : null;
}
