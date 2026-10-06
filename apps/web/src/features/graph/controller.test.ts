/**
 * Per-page controller test (M10 acceptance 3): the graph joins only API data —
 * search seeds the memory nodes, inspect joins entities and edges. Edges the API
 * reports to memories outside the seed are counted, never drawn with an invented
 * node; inspect failures are reported, never dropped silently.
 */

import { describe, expect, test } from 'bun:test';

import { createApiClient } from '../../api/client';
import {
  ENTITY_ID_PGLITE,
  MEMORY_ID_ALPHA,
  MEMORY_ID_BETA,
  PROJECT_ID,
  defaultStubRoutes,
  fixtureEmptySearchResponse,
  fixtureSearchResponse,
  jsonResponse,
  stubApi,
} from '../../test/fixtures';
import { loadGraph } from './controller';

describe('loadGraph', () => {
  test('memory + entity nodes and edges come from search + inspect only', async () => {
    const api = createApiClient({ fetchImpl: stubApi(defaultStubRoutes()) });
    const vm = await loadGraph(api, PROJECT_ID, '', 'fixture-project');

    expect(vm.querySent).toBe('fixture-project');
    // Memory nodes from the search rows.
    const memoryNodes = vm.nodes.filter((node) => node.kind === 'memory');
    expect(memoryNodes.map((node) => node.label)).toEqual([
      'Use PGlite for embedded mode',
      'pgvector extension missing',
    ]);
    expect(memoryNodes[0]?.status).toBe('active');
    expect(memoryNodes[0]?.subtitle).toBe('decision');
    // Entity nodes from the inspect entities of the first memory (the fixture
    // inspect reports one entity row; the second memory's inspect has no route).
    const entityNodes = vm.nodes.filter((node) => node.kind === 'entity');
    expect(entityNodes.map((node) => node.label)).toEqual(['PGlite']);
    expect(entityNodes[0]?.subtitle).toBe('library');
    // Edges: one memory→entity 'mentions' join + the supersedes edge (both seeded).
    expect(vm.edges).toContainEqual({
      from: `memory:${MEMORY_ID_ALPHA}`,
      to: `entity:${ENTITY_ID_PGLITE}`,
      relation: 'mentions',
    });
    expect(vm.edges).toContainEqual({
      from: `memory:${MEMORY_ID_ALPHA}`,
      to: `memory:${MEMORY_ID_BETA}`,
      relation: 'supersedes',
    });
    // The second seed's inspect failed (no stub route for BETA) → reported, not hidden.
    expect(vm.inspectFailures).toEqual([MEMORY_ID_BETA]);
  });

  test('an empty search seeds an empty graph — no fallback nodes', async () => {
    const api = createApiClient({
      fetchImpl: stubApi({
        [`POST /v1/projects/${PROJECT_ID}/search`]: fixtureEmptySearchResponse(),
      }),
    });
    const vm = await loadGraph(api, PROJECT_ID, 'nothing', 'fallback');
    expect(vm.nodes).toEqual([]);
    expect(vm.edges).toEqual([]);
    expect(vm.externalEdgeCount).toBe(0);
  });

  test('edges to memories outside the seed are counted, not drawn', async () => {
    const search = fixtureSearchResponse() as { memories: Array<Record<string, unknown>> };
    // Keep only the first memory seeded; its inspect edge points at BETA which is
    // then outside the seed → external.
    const seededSearch = {
      ...fixtureSearchResponse(),
      memories: [search.memories[0]],
    } as object;
    const api = createApiClient({
      fetchImpl: stubApi({
        [`POST /v1/projects/${PROJECT_ID}/search`]: seededSearch,
        [`GET /v1/projects/${PROJECT_ID}/memories/${MEMORY_ID_ALPHA}`]: defaultStubRoutes()[
          `GET /v1/projects/${PROJECT_ID}/memories/${MEMORY_ID_ALPHA}`
        ],
      }),
    });
    const vm = await loadGraph(api, PROJECT_ID, '', 'fixture-project');
    expect(vm.nodes.every((node) => node.id !== `memory:${MEMORY_ID_BETA}`)).toBeTrue();
    expect(vm.edges.every((edge) => edge.to !== `memory:${MEMORY_ID_BETA}`)).toBeTrue();
    expect(vm.externalEdgeCount).toBe(1);
  });

  test('the query filter rides the search request verbatim', async () => {
    let seenBody: Record<string, unknown> | undefined;
    const api = createApiClient({
      fetchImpl: stubApi({
        [`POST /v1/projects/${PROJECT_ID}/search`]: async (request: Request) => {
          seenBody = (await request.json()) as Record<string, unknown>;
          return jsonResponse(fixtureEmptySearchResponse());
        },
      }),
    });
    await loadGraph(api, PROJECT_ID, 'seed query', 'fallback');
    expect(seenBody).toMatchObject({ query: 'seed query', explain: true });
  });
});
