/**
 * Per-page controller test (M10 acceptance 3): the quality dashboard renders the
 * stats the API reports and samples the status categories via the search include
 * filter — low-confidence/unused are view policy over API fields (stated in the UI),
 * duplicates stay honestly unavailable, nothing is invented.
 */

import { describe, expect, test } from 'bun:test';

import { createApiClient } from '../../api/client';
import type { StatsResponse } from '../../api/schemas';
import {
  MEMORY_ID_ALPHA,
  PROJECT_ID,
  defaultStubRoutes,
  fixtureEmptySearchResponse,
  fixtureMemoryRecord,
  fixtureSearchResponse,
  fixtureStatsResponse,
  jsonResponse,
  stubApi,
} from '../../test/fixtures';
import { LOW_CONFIDENCE_THRESHOLD, loadQuality } from './controller';

const MEMORY_ID_GAMMA = '0195a7f0-9f5e-7a1d-bc2d-000000000005';

/** A search row for the given id with a status-specific marker summary. */
function row(id: string, status: string, marker: string): object {
  return {
    id,
    type: 'semantic',
    title: `${marker} title`,
    summary: `${marker} summary`,
    relevance: 0.5,
    explain: [],
    temporal: { valid_from: '2026-10-01T12:00:00.000Z', status },
    provenance: { source_kind: 'conversation' },
    codeRefs: [],
  };
}

function searchEnvelope(memories: object[]): object {
  return {
    query_understanding: { intent: 'fact', entities: [], keywords: [] },
    memories,
    tokens: { budget: 800, used: 10, packing: 'summary' },
    warnings: [],
  };
}

/** Body-aware search dispatch: each include status gets its own fixture. */
function qualityRoutes(): Parameters<typeof stubApi>[0] {
  const routes = defaultStubRoutes();
  routes[`POST /v1/projects/${PROJECT_ID}/search`] = (request: Request) =>
    request.json().then((raw) => {
      const body = raw as { include?: string[] };
      const include = body.include ?? [];
      if (include.includes('stale')) {
        return jsonResponse(searchEnvelope([row(MEMORY_ID_ALPHA, 'stale', 'fixture stale row')]));
      }
      if (include.includes('disputed')) {
        return jsonResponse(
          searchEnvelope([row(MEMORY_ID_GAMMA, 'disputed', 'fixture disputed row')]),
        );
      }
      if (include.includes('superseded')) {
        return jsonResponse(searchEnvelope([]));
      }
      return jsonResponse(fixtureSearchResponse());
    });
  // Gamma's inspect: low confidence, never accessed → both view-policy flags true.
  const gammaRecord = fixtureMemoryRecord(MEMORY_ID_GAMMA) as Record<string, unknown>;
  gammaRecord.confidence = 0.3;
  gammaRecord.access_count = 0;
  gammaRecord.status = 'disputed';
  routes[`GET /v1/projects/${PROJECT_ID}/memories/${MEMORY_ID_GAMMA}`] = {
    memory: gammaRecord,
    history: [],
    audit: [],
    entities: [],
    edges: [],
    redactions: [],
    warnings: [],
  };
  return routes;
}

describe('loadQuality', () => {
  test('counts pass through from stats; samples pass through from the include-filtered searches', async () => {
    const api = createApiClient({ fetchImpl: stubApi(qualityRoutes()) });
    const vm = await loadQuality(api, PROJECT_ID, 'fixture-project');

    const stats = fixtureStatsResponse() as unknown as StatsResponse;
    expect(vm.stats.memories).toEqual(stats.memories);
    expect(vm.staleSample.querySent).toBe('fixture-project');
    expect(vm.staleSample.memories[0]?.id).toBe(MEMORY_ID_ALPHA);
    expect(vm.staleSample.memories[0]?.temporal.status).toBe('stale');
    expect(vm.disputedSample.memories[0]?.id).toBe(MEMORY_ID_GAMMA);
    expect(vm.supersededSample.memories).toEqual([]);
    expect(vm.warnings).toEqual([]);
  });

  test('enrichment carries the API confidence/access_count; flags are the stated policy', async () => {
    const api = createApiClient({ fetchImpl: stubApi(qualityRoutes()) });
    const vm = await loadQuality(api, PROJECT_ID, 'fixture-project');

    expect(vm.insights.length).toBe(2);
    const alpha = vm.insights.find((row) => row.memoryId === MEMORY_ID_ALPHA);
    const gamma = vm.insights.find((row) => row.memoryId === MEMORY_ID_GAMMA);
    expect(alpha?.confidence).toBe(0.72);
    expect(alpha?.accessCount).toBe(3);
    expect(alpha?.lowConfidence).toBeFalse();
    expect(alpha?.unused).toBeFalse();
    expect(gamma?.confidence).toBe(0.3);
    expect(gamma?.accessCount).toBe(0);
    expect(gamma?.lowConfidence).toBeTrue();
    expect(gamma?.unused).toBeTrue();
    expect(LOW_CONFIDENCE_THRESHOLD).toBe(0.5);
    expect(vm.inspectFailures).toEqual([]);
  });

  test('duplicates stay honestly unavailable — no number is fabricated', async () => {
    const api = createApiClient({ fetchImpl: stubApi(qualityRoutes()) });
    const vm = await loadQuality(api, PROJECT_ID, 'fixture-project');
    expect(vm.duplicatesAvailable).toBeFalse();
  });

  test('all-empty API responses yield an all-empty dashboard', async () => {
    const routes = defaultStubRoutes();
    routes[`POST /v1/projects/${PROJECT_ID}/search`] = fixtureEmptySearchResponse();
    const emptyStats = fixtureStatsResponse() as Record<string, unknown>;
    (emptyStats as { memories: Record<string, unknown> }).memories = {
      total: 0,
      by_status: {},
      by_type: {},
      truncated: false,
    };
    routes[`GET /v1/projects/${PROJECT_ID}/stats`] = emptyStats;
    const api = createApiClient({ fetchImpl: stubApi(routes) });
    const vm = await loadQuality(api, PROJECT_ID, 'fixture-project');

    expect(vm.stats.memories.total).toBe(0);
    expect(vm.staleSample.memories).toEqual([]);
    expect(vm.disputedSample.memories).toEqual([]);
    expect(vm.supersededSample.memories).toEqual([]);
    expect(vm.insights).toEqual([]);
    expect(vm.duplicatesAvailable).toBeFalse();
  });
});
