/**
 * The projects surface: the registered projects (the API's list endpoint, including
 * its honest warnings), plus the active project's stats and the session context
 * block the engine would inject — all three straight from the API.
 */

import type { ApiClient } from '../../api/client';
import type { ProjectListResponse, SessionContextResponse, StatsResponse } from '../../api/schemas';

export interface ProjectOverviewViewModel {
  readonly stats: StatsResponse;
  readonly context: SessionContextResponse;
}

export async function loadProjectOverview(
  api: ApiClient,
  projectId: string,
): Promise<ProjectOverviewViewModel> {
  const [stats, context] = await Promise.all([
    api.stats(projectId),
    api.context(projectId, {}),
  ]);
  return { stats, context };
}

/** Pass-through for the projects list (used by pages that need the raw response). */
export async function loadProjects(api: ApiClient): Promise<ProjectListResponse> {
  return api.listProjects();
}
