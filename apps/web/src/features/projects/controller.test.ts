/**
 * Per-page controller test (M10 acceptance 3): the projects page shows the project
 * list with the API's own warnings, and the active project's stats + session
 * context verbatim — zero projects or zero sections render empty, never invented.
 */

import { describe, expect, test } from 'bun:test';

import { createApiClient } from '../../api/client';
import type {
  ProjectListResponse,
  SessionContextResponse,
  StatsResponse,
} from '../../api/schemas';
import {
  PROJECT_ID,
  defaultStubRoutes,
  fixtureProjectList,
  fixtureSessionContext,
  fixtureStatsResponse,
  stubApi,
} from '../../test/fixtures';
import { loadProjectOverview, loadProjects } from './controller';

describe('loadProjects', () => {
  test("the list and the API warnings pass through untouched", async () => {
    const api = createApiClient({ fetchImpl: stubApi(defaultStubRoutes()) });
    const vm = await loadProjects(api);
    const fixture = fixtureProjectList() as unknown as ProjectListResponse;

    expect(vm.projects).toEqual(fixture.projects);
    expect(vm.projects[0]).toMatchObject({ name: 'fixture-project', id: PROJECT_ID });
    expect(vm.warnings).toEqual([
      'project listing is incomplete: storage exposes no list-projects query (fixture)',
    ]);
  });

  test('zero projects renders as zero projects', async () => {
    const api = createApiClient({
      fetchImpl: stubApi({ 'GET /v1/projects': { projects: [], warnings: [] } }),
    });
    const vm = await loadProjects(api);
    expect(vm.projects).toEqual([]);
  });
});

describe('loadProjectOverview', () => {
  test('stats and session context pass through untouched', async () => {
    const api = createApiClient({ fetchImpl: stubApi(defaultStubRoutes()) });
    const vm = await loadProjectOverview(api, PROJECT_ID);
    const stats = fixtureStatsResponse() as unknown as StatsResponse;
    const context = fixtureSessionContext() as unknown as SessionContextResponse;

    expect(vm.stats.project_id).toBe(PROJECT_ID);
    expect(vm.stats.memories).toEqual(stats.memories);
    expect(vm.stats.memories.total).toBe(12);
    expect(vm.stats.working_memory).toEqual({ session_id: 'fixture-session', depth: 2 });
    expect(vm.stats.jobs).toEqual({ pending: 1, running: 0, dead: 0 });
    expect(vm.context.budget).toBe(750);
    expect(vm.context.used).toBe(210);
    expect(vm.context.sections).toEqual(context.sections);
  });

  test("jobs null and working memory null pass through (the API honest gaps)", async () => {
    const stats = fixtureStatsResponse() as Record<string, unknown>;
    stats.jobs = null;
    stats.working_memory = null;
    const api = createApiClient({
      fetchImpl: stubApi({
        [`GET /v1/projects/${PROJECT_ID}/stats`]: stats,
        [`GET /v1/projects/${PROJECT_ID}/context`]: fixtureSessionContext(),
      }),
    });
    const vm = await loadProjectOverview(api, PROJECT_ID);
    expect(vm.stats.jobs).toBeNull();
    expect(vm.stats.working_memory).toBeNull();
  });
});
