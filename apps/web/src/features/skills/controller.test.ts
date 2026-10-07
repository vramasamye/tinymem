/**
 * Per-page controller test (M10 acceptance 3): the skills page shows skill payloads
 * the API actually carries (procedural memories whose inspect payload parses as a
 * skill payload) — no skills is rendered as no skills, never a fabricated card.
 */

import { describe, expect, test } from 'bun:test';

import { createApiClient } from '../../api/client';
import {
  MEMORY_ID_PROCEDURAL,
  PROJECT_ID,
  SKILL_ID_CANDIDATE,
  SKILL_ID_VERIFIED,
  defaultStubRoutes,
  fixtureMemoryRecord,
  fixtureProceduralSearchResponse,
  stubApi,
} from '../../test/fixtures';
import { loadSkills } from './controller';

function skillsRoutes(): Parameters<typeof stubApi>[0] {
  const routes = defaultStubRoutes();
  routes[`POST /v1/projects/${PROJECT_ID}/search`] = fixtureProceduralSearchResponse();
  return routes;
}

describe('loadSkills', () => {
  test('a procedural memory carrying a skill payload surfaces as a skill card', async () => {
    const api = createApiClient({ fetchImpl: stubApi(skillsRoutes()) });
    const vm = await loadSkills(api, PROJECT_ID);

    expect(vm.querySent).toBe('skill'); // the API's typed-list synthesis convention
    expect(vm.procedural.length).toBe(1);
    expect(vm.procedural[0]?.id).toBe(MEMORY_ID_PROCEDURAL);
    expect(vm.skills.length).toBe(1);
    const card = vm.skills[0];
    expect(card?.memoryId).toBe(MEMORY_ID_PROCEDURAL);
    expect(card?.skill.name).toBe('restore-pgvector-extension');
    expect(card?.skill.version).toBe('1.2.0');
    expect(card?.skill.status).toBe('verified');
    expect(card?.skill.path).toBe('skills/restore-pgvector-extension/SKILL.md');
    expect(card?.skill.usage_count).toBe(2);
    expect(card?.skill.verification.verified_at).toBe('2026-10-01T12:00:00.000Z');
    expect(card?.evidenceCount).toBe(1);
    expect(vm.inspectFailures).toEqual([]);
  });

  test('a procedural memory without a skill payload stays a procedure — no invented skill', async () => {
    const routes = skillsRoutes();
    // The inspect returns the procedural memory WITHOUT any payload.
    const record = fixtureMemoryRecord(MEMORY_ID_PROCEDURAL) as Record<string, unknown>;
    delete record.payload;
    routes[`GET /v1/projects/${PROJECT_ID}/memories/${MEMORY_ID_PROCEDURAL}`] = {
      memory: record,
      history: [],
      audit: [],
      entities: [],
      edges: [],
      redactions: [],
      warnings: [],
    };
    const api = createApiClient({ fetchImpl: stubApi(routes) });
    const vm = await loadSkills(api, PROJECT_ID);

    expect(vm.skills).toEqual([]);
    expect(vm.procedural.length).toBe(1); // still listed honestly as a procedure
  });

  test('the review queue comes from the skills endpoint, candidates first', async () => {
    const api = createApiClient({ fetchImpl: stubApi(skillsRoutes()) });
    const vm = await loadSkills(api, PROJECT_ID);

    expect(vm.queue.map((skill) => [skill.id, skill.status])).toEqual([
      [SKILL_ID_CANDIDATE, 'candidate'],
      [SKILL_ID_VERIFIED, 'verified'],
    ]);
    expect(vm.pendingReview).toBe(1);
  });

  test('a failed inspect is reported, and the row stays listed', async () => {
    const routes = skillsRoutes();
    delete routes[`GET /v1/projects/${PROJECT_ID}/memories/${MEMORY_ID_PROCEDURAL}`];
    const api = createApiClient({ fetchImpl: stubApi(routes) });
    const vm = await loadSkills(api, PROJECT_ID);

    expect(vm.skills).toEqual([]);
    expect(vm.inspectFailures).toEqual([MEMORY_ID_PROCEDURAL]);
    expect(vm.procedural.length).toBe(1);
  });
});
