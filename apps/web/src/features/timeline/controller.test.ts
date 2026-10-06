/**
 * Per-page controller test (M10 acceptance 3): the timeline page shows the audit
 * trail (memory_events) and supersession chain exactly as the inspect API returned
 * them — an empty trail renders empty, never a fabricated status history.
 */

import { describe, expect, test } from 'bun:test';

import { createApiClient } from '../../api/client';
import type { InspectResponse } from '../../api/schemas';
import {
  MEMORY_ID_ALPHA,
  PROJECT_ID,
  apiErrorBody,
  defaultStubRoutes,
  fixtureInspectResponse,
  jsonResponse,
  stubApi,
} from '../../test/fixtures';
import { loadTimeline } from './controller';

describe('loadTimeline', () => {
  test('the audit trail, chain and warnings pass through untouched', async () => {
    const api = createApiClient({ fetchImpl: stubApi(defaultStubRoutes()) });
    const vm = await loadTimeline(api, PROJECT_ID, MEMORY_ID_ALPHA);
    const fixture = fixtureInspectResponse() as unknown as InspectResponse;

    expect(vm.memoryId).toBe(MEMORY_ID_ALPHA);
    expect(vm.label).toBe('Use PGlite for embedded mode');
    expect(vm.currentStatus).toBe('active');
    // The status history IS the API's audit array — event for event.
    expect(vm.audit).toEqual(fixture.audit);
    expect(vm.audit.map((event) => event.action)).toEqual(['created', 'status_changed']);
    expect(vm.audit[1]?.from_status).toBe('active');
    expect(vm.audit[1]?.to_status).toBe('stale');
    expect(vm.audit[1]?.actor).toBe('drift-scan');
    expect(vm.audit[1]?.details).toEqual({ reason: 'fixture drift: cited file changed' });
    expect(vm.history).toEqual(fixture.history);
    expect(vm.entities).toEqual(fixture.entities);
  });

  test('a memory without a title falls back to the API content summary — never to chrome', async () => {
    const inspect = fixtureInspectResponse() as { memory: Record<string, unknown> };
    delete inspect.memory.title;
    delete inspect.memory.content_summary;
    inspect.memory.content = 'fixture content is the label';
    const api = createApiClient({
      fetchImpl: stubApi({
        [`GET /v1/projects/${PROJECT_ID}/memories/${MEMORY_ID_ALPHA}`]: inspect,
      }),
    });
    const vm = await loadTimeline(api, PROJECT_ID, MEMORY_ID_ALPHA);
    expect(vm.label).toBe('fixture content is the label');
  });

  test('an unknown memory surfaces the API 404 error, not an invented timeline', async () => {
    const api = createApiClient({
      fetchImpl: stubApi({
        [`GET /v1/projects/${PROJECT_ID}/memories/${MEMORY_ID_ALPHA}`]: jsonResponse(
          apiErrorBody('not_found', 'memory not found'),
          404,
        ),
      }),
    });
    try {
      await loadTimeline(api, PROJECT_ID, MEMORY_ID_ALPHA);
      throw new Error('expected loadTimeline to throw');
    } catch (error) {
      expect((error as { code: string }).code).toBe('not_found');
      expect((error as { message: string }).message).toBe('memory not found');
    }
  });
});
